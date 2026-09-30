import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/pages/news_home_controller.dart';
import 'package:news_app/models/conversation_pattern.dart';
import 'package:news_app/models/news_item.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/reply_cache_service.dart';
import 'package:news_app/services/saved_thread_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const url = 'https://example.com/saved';
  const article = NewsItem(
    title: '保存タイトル',
    description: '保存概要',
    url: url,
    time: '2026/09/10',
    category: '配信元',
    feedUrl: 'https://example.com/feed',
    articleId: 'article-1',
    appCategories: ['IT・ガジェット'],
  );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('記事情報・表示済みレス・削除状態を保存して復元する', () async {
    final replies = [
      _reply(ReplyOrigin.sharedAi, id: 'shared-1'),
      _reply(ReplyOrigin.user, id: 'user-1', isDeleted: true),
      _reply(ReplyOrigin.localAi, id: 'local-1', replyTo: 2),
    ];
    await SavedThreadService.save(
      SavedThreadArchive(
        article: article,
        replies: replies,
        loadedSharedChunkCount: 1,
      ),
    );

    final restored = await SavedThreadService.load(url);
    expect(restored, isNotNull);
    expect(restored!.article.title, '保存タイトル');
    expect(restored.article.description, '保存概要');
    expect(restored.article.category, '配信元');
    expect(restored.replies.map((reply) => reply.origin), [
      ReplyOrigin.sharedAi,
      ReplyOrigin.user,
      ReplyOrigin.localAi,
    ]);
    expect(restored.replies[1].isDeleted, isTrue);
    expect(restored.replies[2].replyTo, 2);
  });

  test('配信キャッシュから消えた記事も保存一覧用データを復元する', () async {
    await SavedThreadService.saveArticle(article);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList('saved_news_urls', [url]);
    final controller = NewsHomeController(
      fetchNewsData: () async => [],
      fetchRssCache: (_) async => [],
    );

    await controller.initialize();

    expect(controller.allNews.single.url, url);
    expect(controller.allNews.single.title, '保存タイトル');
    controller.dispose();
  });

  test('保存記事はローカル復元だけで初期表示し生存確認しない', () async {
    var statusChecks = 0;
    final archive = SavedThreadArchive(
      article: article,
      replies: [
        ...List.generate(
          10,
          (index) => _reply(ReplyOrigin.sharedAi, id: 'shared-$index'),
        ),
        _reply(ReplyOrigin.user, id: 'user', isDeleted: true),
        _reply(ReplyOrigin.localAi, id: 'local', replyTo: 11),
      ],
      loadedSharedChunkCount: 1,
    );
    final controller = NewsDetailController(
      articleTitle: article.title,
      articleBody: article.description,
      newsUrl: url,
      sourceName: article.category,
      isSaved: true,
      archiveLoader: (_) async => archive,
      archiveSaver: (_) async {},
      serverThreadChecker: (_) async {
        statusChecks++;
        return ServerThreadStatus.exists;
      },
    );

    await controller.loadInitialReplies();

    expect(statusChecks, 0);
    expect(controller.replies, hasLength(12));
    expect(controller.replies[10].isDeleted, isTrue);
    expect(controller.replies[11].replyTo, 11);
    controller.dispose();
  });

  test('明確な不存在だけでread-onlyへ移行し保存する', () async {
    SavedThreadArchive? saved;
    var chunkLoads = 0;
    final controller = _savedController(
      article,
      status: ServerThreadStatus.notFound,
      archiveSaver: (archive) async => saved = archive,
      chunkLoader: (_) async {
        chunkLoads++;
        return _chunk(2);
      },
    );

    await controller.loadInitialReplies();
    await controller.loadMoreReplies();

    expect(controller.isReadOnly, isTrue);
    expect(controller.replies, hasLength(10));
    expect(chunkLoads, 0);
    expect(saved?.isReadOnly, isTrue);
    controller.dispose();
  });

  test('通信不能は終了扱いにせず次チャンクを追加保存する', () async {
    SavedThreadArchive? saved;
    final controller = _savedController(
      article,
      status: ServerThreadStatus.unavailable,
      archiveSaver: (archive) async => saved = archive,
      chunkLoader: (_) async => _chunk(2),
    );

    await controller.loadInitialReplies();
    await controller.loadMoreReplies();

    expect(controller.isReadOnly, isFalse);
    expect(controller.replies, hasLength(20));
    expect(saved?.loadedSharedChunkCount, 2);
    expect(saved?.replies, hasLength(20));
    controller.dispose();
  });

  test('削除は番号・localAi・アンカーを維持し通常記事では保存しない', () async {
    var saves = 0;
    final controller = NewsDetailController(
      articleTitle: article.title,
      articleBody: article.description,
      newsUrl: url,
      archiveSaver: (_) async => saves++,
    );
    controller.replies.addAll([
      _reply(ReplyOrigin.sharedAi, id: 'shared'),
      _reply(ReplyOrigin.user, id: 'user'),
      _reply(ReplyOrigin.localAi, id: 'local', replyTo: 2),
    ]);

    expect(await controller.deleteUserComment(2), isTrue);
    expect(controller.replies, hasLength(3));
    expect(controller.replies[1].isDeleted, isTrue);
    expect(controller.replies[2].origin, ReplyOrigin.localAi);
    expect(controller.replies[2].replyTo, 2);
    expect(saves, 0);
    controller.dispose();
  });
}

NewsDetailController _savedController(
  NewsItem article, {
  required ServerThreadStatus status,
  required Future<void> Function(SavedThreadArchive) archiveSaver,
  required Future<CachedReplyChunk?> Function(int) chunkLoader,
}) {
  final initialReplies = List.generate(
    10,
    (index) => _reply(ReplyOrigin.sharedAi, id: 'shared-$index'),
  );
  return NewsDetailController(
    articleTitle: article.title,
    articleBody: article.description,
    newsUrl: article.url,
    sourceName: article.category,
    isSaved: true,
    archiveLoader: (_) async => SavedThreadArchive(
      article: article,
      replies: initialReplies,
      loadedSharedChunkCount: 1,
    ),
    archiveSaver: archiveSaver,
    serverThreadChecker: (_) async => status,
    sharedChunkLoader: chunkLoader,
  );
}

CachedReplyChunk _chunk(int chunkIndex) => CachedReplyChunk(
  replies: List.generate(
    10,
    (index) => _reply(
      ReplyOrigin.sharedAi,
      id: 'shared-${(chunkIndex - 1) * 10 + index}',
    ),
  ),
  conversation: const ConversationPlan(
    pattern: ConversationPattern.independent,
    relations: [],
  ),
);

ReplyItem _reply(
  ReplyOrigin origin, {
  required String id,
  int? replyTo,
  bool isDeleted = false,
}) => ReplyItem(
  text: '本文-$id',
  type: origin == ReplyOrigin.user ? ReplyType.user : ReplyType.ai,
  name: origin == ReplyOrigin.user ? '自分' : '名無しのAIさん',
  id: id,
  replyTo: replyTo,
  origin: origin,
  isDeleted: isDeleted,
);
