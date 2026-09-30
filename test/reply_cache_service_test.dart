import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/ai_service.dart';
import 'package:news_app/models/conversation_pattern.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/reply_cache_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final backend = _CacheBackend();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await Supabase.initialize(
      url: 'https://example.supabase.co',
      publishableKey: 'test-publishable-key',
      httpClient: MockClient(backend.handle),
      authOptions: const FlutterAuthClientOptions(
        localStorage: EmptyLocalStorage(),
      ),
    );
  });

  setUp(backend.reset);

  test('new article is inserted and its shared chunk is saved', () async {
    await _saveChunk();

    expect(backend.article?['news_url'], _url);
    expect(backend.articlePosts, 1);
    expect(backend.chunks, hasLength(1));
    expect(backend.chunks.single['article_id'], backend.article?['id']);
    expect(backend.articleUpdates.single.keys.toSet(), {
      'news_title',
      'updated_at',
      'last_accessed_at',
    });
    expect(backend.articleInsertBodies.single.keys.toSet(), {
      'news_url',
      'news_title',
      'updated_at',
      'last_accessed_at',
    });
  });

  test(
    'existing article updates allowed columns and saves the chunk',
    () async {
      backend.seedArticle();

      await _saveChunk();

      expect(backend.articlePosts, 0);
      expect(backend.articleUpdates, hasLength(1));
      expect(backend.article?['news_title'], _title);
      expect(backend.chunks, hasLength(1));
    },
  );

  test(
    'unique conflict from concurrent creation reuses the winning article',
    () async {
      backend.raceOnArticleInsert = true;

      await _saveChunk();

      expect(backend.articlePosts, 1);
      expect(backend.article?['id'], 77);
      expect(backend.articleSelects, 1);
      expect(backend.chunks, hasLength(1));
      expect(backend.chunks.single['article_id'], 77);
    },
  );

  test('saved cache is a HIT when the same article is opened again', () async {
    await _saveChunk();
    final generationRequestsBefore = backend.generationRequests;
    var routerRequests = 0;
    final controller = NewsDetailController(
      articleTitle: _title,
      articleBody: '本文',
      newsUrl: _url,
      topicId: '00000000-0000-0000-0000-000000000001',
      sharedInitialRequester: (_) async {
        routerRequests++;
        return const SharedInitialResult(status: SharedInitialStatus.ready);
      },
    );
    addTearDown(controller.dispose);

    await controller.loadInitialReplies();

    expect(controller.replies, hasLength(10));
    expect(
      controller.replies.every((reply) => reply.origin == ReplyOrigin.sharedAi),
      isTrue,
    );
    expect(backend.generationRequests, generationRequestsBefore);
    expect(routerRequests, 0);
  });

  test(
    'initial Topic MISS requests the router once and reads its saved chunk',
    () async {
      var requests = 0;
      var storedByServer = 0;
      final controller = NewsDetailController(
        articleTitle: _title,
        articleBody: '本文',
        newsUrl: _url,
        topicId: '00000000-0000-0000-0000-000000000001',
        sharedInitialRequester: (_) async {
          requests++;
          await _saveChunk(); // Mock the router's server-side append.
          storedByServer = backend.chunks.length;
          return const SharedInitialResult(status: SharedInitialStatus.ready);
        },
      );
      addTearDown(controller.dispose);

      await Future.wait([
        controller.loadInitialReplies(),
        controller.loadInitialReplies(),
      ]);

      expect(requests, 1);
      expect(controller.replies, hasLength(10));
      expect(controller.isLoading, isFalse);
      expect(controller.isGenerating, isFalse);
      expect(backend.chunks, hasLength(storedByServer));
    },
  );

  test(
    'initial Topic MISS polls running and does not save on the Flutter side',
    () async {
      var requests = 0;
      var storedByServer = 0;
      final controller = NewsDetailController(
        articleTitle: _title,
        articleBody: '本文',
        newsUrl: _url,
        topicId: '00000000-0000-0000-0000-000000000001',
        sharedInitialRequester: (_) async {
          requests++;
          if (requests == 1) {
            return const SharedInitialResult(
              status: SharedInitialStatus.running,
            );
          }
          await _saveChunk();
          storedByServer = backend.chunks.length;
          return const SharedInitialResult(status: SharedInitialStatus.ready);
        },
      );
      addTearDown(controller.dispose);

      await controller.loadInitialReplies();

      expect(requests, 2);
      expect(controller.replies, hasLength(10));
      expect(controller.loadMoreErrorMessage, isNull);
      expect(backend.chunks, hasLength(storedByServer));
    },
  );

  test(
    'router deferred or exhausted ends loading and exposes retry state',
    () async {
      final controller = NewsDetailController(
        articleTitle: _title,
        articleBody: '本文',
        newsUrl: _url,
        topicId: '00000000-0000-0000-0000-000000000001',
        sharedInitialRequester: (_) async =>
            const SharedInitialResult(status: SharedInitialStatus.deferred),
      );
      addTearDown(controller.dispose);

      await controller.loadInitialReplies();

      expect(controller.replies, isEmpty);
      expect(controller.isLoading, isFalse);
      expect(controller.isGenerating, isFalse);
      expect(controller.loadMoreErrorMessage, isNotNull);
      expect(backend.generationRequests, 0);
    },
  );

  test(
    'disposing during router polling prevents a later cache read or UI update',
    () async {
      final started = Completer<void>();
      final response = Completer<SharedInitialResult>();
      final controller = NewsDetailController(
        articleTitle: _title,
        articleBody: '本文',
        newsUrl: _url,
        topicId: '00000000-0000-0000-0000-000000000001',
        sharedInitialRequester: (_) {
          started.complete();
          return response.future;
        },
      );
      var notifications = 0;
      controller.addListener(() => notifications++);

      final load = controller.loadInitialReplies();
      await started.future;
      controller.dispose();
      final afterDispose = notifications;
      final cacheReadsBeforeResponse = backend.chunkGets;
      response.complete(
        const SharedInitialResult(status: SharedInitialStatus.ready),
      );
      await load;

      expect(backend.chunkGets, cacheReadsBeforeResponse);
      expect(notifications, afterDispose);
    },
  );
}

const _url = 'https://example.com/shared-cache';
const _title = '共有キャッシュ記事';

Future<void> _saveChunk() => ReplyCacheService.saveChunk(
  newsUrl: _url,
  newsTitle: _title,
  chunkIndex: 1,
  replies: List.generate(
    10,
    (index) => ReplyItem(
      text: 'レス${index + 1}',
      type: ReplyType.ai,
      name: '住人',
      id: 'user-${index + 1}',
      origin: ReplyOrigin.sharedAi,
    ).toJson(),
  ),
  conversationPattern: ConversationPattern.independent,
);

class _CacheBackend {
  Map<String, dynamic>? article;
  final List<Map<String, dynamic>> chunks = [];
  final List<Map<String, dynamic>> articleUpdates = [];
  final List<Map<String, dynamic>> articleInsertBodies = [];
  int articlePosts = 0;
  int articleSelects = 0;
  int generationRequests = 0;
  int chunkGets = 0;
  bool raceOnArticleInsert = false;
  bool _raceTriggered = false;

  void reset() {
    article = null;
    chunks.clear();
    articleUpdates.clear();
    articleInsertBodies.clear();
    articlePosts = 0;
    articleSelects = 0;
    generationRequests = 0;
    chunkGets = 0;
    raceOnArticleInsert = false;
    _raceTriggered = false;
  }

  void seedArticle() {
    article = {
      'id': 1,
      'news_url': _url,
      'news_title': '以前のタイトル',
      'updated_at': '2026-01-01T00:00:00Z',
      'last_accessed_at': '2026-01-01T00:00:00Z',
    };
  }

  Future<http.Response> handle(http.Request request) async {
    final path = request.url.path;
    if (path.endsWith('/functions/v1/generate-ai-replies')) {
      generationRequests++;
      return _json([], 500, request);
    }
    if (path.endsWith('/rest/v1/articles')) {
      return _handleArticles(request);
    }
    if (path.endsWith('/rest/v1/thread_chunks')) {
      return _handleChunks(request);
    }
    if (path.endsWith('/rest/v1/rpc/record_visible_replies')) {
      return http.Response('', 204, request: request);
    }
    return _json({'message': 'unexpected request'}, 500, request);
  }

  Future<http.Response> _handleArticles(http.Request request) async {
    final query = request.url.queryParameters;
    final requestedUrl = _filterValue(query['news_url']);
    if (request.method == 'PATCH') {
      final body = _body(request);
      articleUpdates.add(body);
      const permittedUpdates = {'news_title', 'updated_at', 'last_accessed_at'};
      if (!permittedUpdates.containsAll(body.keys)) {
        return _json({'code': '42501'}, 401, request);
      }
      if (article?['news_url'] != requestedUrl) return _noSingleRow(request);
      article!.addAll(body);
      return _json(
        [
          {'id': article!['id']},
        ],
        200,
        request,
      );
    }
    if (request.method == 'POST') {
      articlePosts++;
      final body = _body(request);
      articleInsertBodies.add(body);
      if (raceOnArticleInsert && !_raceTriggered) {
        _raceTriggered = true;
        article = {
          'id': 77,
          'news_url': body['news_url'],
          'news_title': '別クライアントが作成',
          'updated_at': body['updated_at'],
          'last_accessed_at': body['last_accessed_at'],
        };
        return _json(
          {
            'code': '23505',
            'message': 'duplicate key value violates unique constraint',
          },
          409,
          request,
        );
      }
      if (article?['news_url'] == body['news_url']) {
        return _json({'code': '23505'}, 409, request);
      }
      article = {'id': 1, ...body};
      return _json(
        [
          {'id': article!['id']},
        ],
        201,
        request,
      );
    }
    if (request.method == 'GET') {
      articleSelects++;
      if (article?['news_url'] != requestedUrl) return _noSingleRow(request);
      final row = {'id': article!['id']};
      return _json(_raceTriggered ? [row] : row, 200, request);
    }
    return _json({'code': 'method_not_allowed'}, 405, request);
  }

  Future<http.Response> _handleChunks(http.Request request) async {
    if (request.method == 'POST') {
      final body = _body(request);
      final exists = chunks.any(
        (chunk) =>
            chunk['article_id'] == body['article_id'] &&
            chunk['chunk_index'] == body['chunk_index'],
      );
      if (!exists) chunks.add(body);
      return http.Response('', 201, request: request);
    }
    if (request.method == 'GET') {
      chunkGets++;
      final articleId = int.tryParse(
        _filterValue(request.url.queryParameters['article_id']) ?? '',
      );
      return _json(
        chunks.where((chunk) => chunk['article_id'] == articleId).toList(),
        200,
        request,
      );
    }
    return _json({'code': 'method_not_allowed'}, 405, request);
  }

  Map<String, dynamic> _body(http.Request request) =>
      jsonDecode(request.body) as Map<String, dynamic>;

  String? _filterValue(String? value) =>
      value != null && value.startsWith('eq.') ? value.substring(3) : null;

  http.Response _json(Object body, int status, http.Request request) =>
      http.Response(
        jsonEncode(body),
        status,
        request: request,
        headers: {'content-type': 'application/json'},
      );

  http.Response _noSingleRow(http.Request request) => _json([], 200, request);
}
