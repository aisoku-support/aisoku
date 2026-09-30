import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../ai_service.dart';
import '../models/ai_reply_report.dart';
import '../models/conversation_pattern.dart';
import '../models/reply_ad_policy.dart';
import '../models/ad_identity.dart';
import '../models/news_item.dart';
import '../services/monetization_analytics_service.dart';
import '../services/thread_ad_session.dart';
import '../models/reply_item.dart';
import '../models/reply_submission_analysis.dart';
import '../reply_cache_service.dart';
import '../services/ai_chunk_analytics_service.dart';
import '../services/ai_reply_report_service.dart';
import '../services/saved_thread_service.dart';
import '../widgets/input_limit_utils.dart';
import '../widgets/pr_card.dart';

class NewsDetailController extends ChangeNotifier {
  String articleTitle;
  String articleBody;
  final String newsUrl;
  final String? newsCategory;
  final String sourceName;
  final bool isSaved;
  final String? topicSubject;
  final String? topicEvent;
  final List<String> topicFacts;
  final String? topicThreadTitle;
  final String? topicCreationMode;
  final String? topicId;

  bool articleReady = false;
  bool isLoading = false;
  bool isGenerating = false;
  bool isReadOnly = false;

  /// DBに保存されている総レス数（共有系列）
  int dbReplyCount = 0;

  /// 画面を開いた直後にDBに存在していたレス数（共有系列）
  int initialDbReplyCount = 0;

  /// キャッシュから読み込んだ未表示のレス
  final List<ReplyItem> _cachedQueue = [];

  /// 初回生成ユーザーかどうか（キャッシュなしで開始した場合）
  bool initialGeneration = false;

  /// 共有AI系列（DB保存対象・生成コンテキスト対象）
  final List<ReplyItem> _sharedReplies = [];

  /// 新方式で生成され、構造を検証できた共有AIチャンクだけを計測対象にする。
  final Map<int, ConversationPlan> _chunkConversations = {};
  final Map<int, int> _chunkReplyCounts = {};
  int? _currentlyViewedChunk;

  /// 共有AI系列のレス番号（1-based）から画面上の表示番号（1-based）への変換マップ
  final Map<int, int> _sharedIndexToDisplayNumber = {};

  final ReplyAdPolicy _adPolicy = ReplyAdPolicy();
  late final ThreadAdSession threadAds = ThreadAdSession(
    policy: _adPolicy,
    onChanged: _safeNotifyListeners,
  );
  final Map<int, String> _sharedGenerationIds = {};

  /// 広告を表示する直前のレスのインデックスと配置タイプ
  Map<int, AdPlacement> get adPlacements => _adPolicy.placements;

  /// 現在取得・生成中のチャンクインデックス
  final Set<int> _loadingChunks = {};

  /// AI返信生成中のユーザー投稿IDと表示文言のマップ
  final Map<String, String> _generatingUserMessages = {};

  /// 共有系列の生成中文言
  String? _sharedLoadingMessage;
  String? get sharedLoadingMessage => _sharedLoadingMessage;
  String? _loadMoreErrorMessage;
  String? get loadMoreErrorMessage => _loadMoreErrorMessage;

  @visibleForTesting
  final Future<CachedReplyChunk?> Function(int chunkIndex)? sharedChunkLoader;
  @visibleForTesting
  final Future<SharedInitialResult> Function(String topicId)?
  sharedInitialRequester;
  final Future<SavedThreadArchive?> Function(String newsUrl) archiveLoader;
  final Future<void> Function(SavedThreadArchive archive) archiveSaver;
  final Future<ServerThreadStatus> Function(String newsUrl) serverThreadChecker;
  SavedThreadArchive? _archive;

  final List<ReplyItem> replies = [];
  final Set<String> _reportedReplyIds = {};
  final Set<String> _reportingReplyIds = {};
  final Future<void> Function(AiReplyReport) reportSaver;

  bool isReplyReported(ReplyItem reply) =>
      _reportedReplyIds.contains(reply.reportTargetId);

  Future<bool> reportReply(
    ReplyItem reply,
    AiReplyReportType type, {
    String? note,
  }) async {
    final targetId = reply.reportTargetId;
    if (_disposed ||
        !reply.canReport ||
        targetId == null ||
        !_reportingReplyIds.add(targetId)) {
      return false;
    }

    if (type == AiReplyReportType.other &&
        note != null &&
        !InputLimitUtils.isValidLength(note)) {
      _reportingReplyIds.remove(targetId);
      return false;
    }

    try {
      await reportSaver(
        AiReplyReport(reply: reply, newsUrl: newsUrl, type: type, note: note),
      );
      if (!_disposed) {
        _reportedReplyIds.add(targetId);
        _safeNotifyListeners();
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      _reportingReplyIds.remove(targetId);
    }
  }

  final Random _random = Random();

  bool _disposed = false;

  /// ジャンプ要求されたレス番号
  int? pendingJumpNumber;

  /// ジャンプ要求時のソース（成功後に jumpSourceNumber へ移動）
  int? pendingSourceNumber;

  /// ジャンプ元のレス番号（戻る用。ジャンプ成功時のみ設定される）
  int? jumpSourceNumber;

  NewsDetailController({
    required this.articleTitle,
    required this.articleBody,
    required this.newsUrl,
    this.newsCategory,
    this.sourceName = '',
    this.isSaved = false,
    this.topicSubject,
    this.topicEvent,
    this.topicFacts = const [],
    this.topicThreadTitle,
    this.topicCreationMode,
    this.topicId,
    this.sharedChunkLoader,
    this.sharedInitialRequester,
    this.archiveLoader = SavedThreadService.load,
    this.archiveSaver = SavedThreadService.save,
    this.serverThreadChecker = _checkServerThread,
    this.reportSaver = AiReplyReportService.save,
  });

  static Future<ServerThreadStatus> _checkServerThread(String newsUrl) =>
      ReplyCacheService.checkThreadStatus(newsUrl: newsUrl);

  @override
  void dispose() {
    _disposed = true;
    threadAds.dispose();
    super.dispose();
  }

  void _safeNotifyListeners() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  /// ジャンプをリクエストする
  void requestJump(int targetNumber, {int? sourceNumber}) {
    pendingJumpNumber = targetNumber;
    pendingSourceNumber = sourceNumber;
    debugPrint(
      '[ThreadJump] request jump to=$targetNumber source=$sourceNumber',
    );
    _safeNotifyListeners();
  }

  /// ジャンプ成功を通知し、戻り先を確定させる
  void setJumpSuccess() {
    if (pendingJumpNumber != null) {
      jumpSourceNumber = pendingSourceNumber;
      pendingJumpNumber = null;
      pendingSourceNumber = null;
      debugPrint(
        '[ThreadJump] jump success. back available to=$jumpSourceNumber',
      );
      _safeNotifyListeners();
    }
  }

  /// ジャンプ失敗（または中止）を通知する
  void cancelJump(String reason) {
    if (pendingJumpNumber != null) {
      debugPrint('[ThreadJump] jump cancelled: $reason');
      pendingJumpNumber = null;
      pendingSourceNumber = null;
      _safeNotifyListeners();
    }
  }

  /// ジャンプ元へ戻る
  void jumpBack() {
    if (jumpSourceNumber != null) {
      final target = jumpSourceNumber!;
      debugPrint('[ThreadJump] back jump to=$target');
      requestJump(target, sourceNumber: null); // 戻る時はソースをクリア
    }
  }

  String? getGeneratingMessageFor(String userId) =>
      _generatingUserMessages[userId];

  String _pickRandomMessage(List<String> list) =>
      list[_random.nextInt(list.length)];

  static const List<String> sharedErrorMessages = [
    'このスレッドは過疎っているようです…',
    'どうやら住民たちはお休み中のようです。',
    'ただいま住民の姿が見当たりません。',
    '住民たちは少し席を外しているようです。',
    'このスレッドは現在、静まり返っています。',
    'どうやら住民たちは休憩中のようです。',
    'ただいまレスが途絶えているようです。',
    '住民たちは現在、行方不明のようです。',
    'このスレッドには静かな時間が流れています。',
    'どうやら住民たちは留守のようです。',
    'どうやら住民たちはROMっているようです…',
    'ただいまROM専の住民しかいないようです。',
    '住民たちは静かにスレッドを見守っています。',
    'どうやら全員ROMモードに入ったようです。',
    '書き込む住民が現れるのを待っています…',
  ];

  static const List<String> _sharedLoadingMessages = [
    '住人たちがざわついています…',
    '誰かがレスを書いています…',
    'スレが少し動きそうです…',
    '住人が何か言いたそうです…',
    'レスが飛んできそうです…',
    '名無しのAIさんたちが集まっています…',
  ];

  static const List<String> _userReplyMessages = [
    'あなたの投稿に住人が反応しています…',
    'あなた宛てのレスが来そうです…',
    'あなたの書き込みに食いついたようです…',
    '誰かがあなたにレスを書いています…',
    'あなたの投稿を見て、住人がざわついています…',
    'どうやらあなたの投稿に反応があるようです…',
  ];

  static const List<String> _specificReplyMessages = [
    'あの住人が返信を考えています…',
    'どうやら本人が反応したようです…',
    'あの住人が何か言いたそうです…',
    '返信先の住人が書き込んでいます…',
    'あの住人からレスが来そうです…',
    '呼ばれた住人が反応しています…',
  ];

  String randomId() {
    const chars =
        'abcdefghijklmnopqrstuvwxyz'
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        '0123456789';

    return List.generate(6, (_) => chars[_random.nextInt(chars.length)]).join();
  }

  ReplyItem _createAiReply({
    required String text,
    String? id,
    int? replyTo,
    ReplyOrigin origin = ReplyOrigin.sharedAi,
  }) {
    return ReplyItem(
      text: text,
      type: ReplyType.ai,
      name: '名無しのAIさん',
      id: id ?? randomId(),
      replyTo: replyTo,
      origin: origin,
      reportTargetId: origin == ReplyOrigin.localAi
          ? AiReplyReport.localTargetId()
          : null,
    );
  }

  List<ReplyItem> _createAiItems({
    required List<String> texts,
    int? replyTo,
    ReplyOrigin origin = ReplyOrigin.sharedAi,
  }) {
    final items = <ReplyItem>[];
    for (final text in texts) {
      final trimmed = text.trim();
      if (trimmed.isEmpty) continue;
      items.add(
        _createAiReply(text: trimmed, replyTo: replyTo, origin: origin),
      );
    }
    return items;
  }

  ReplyItem? findReferencedReply(int replyNumber) {
    if (replyNumber < 1 || replyNumber > replies.length) return null;
    return replies[replyNumber - 1];
  }

  /// レスを画面と共有系列に追加する。
  /// [showAdAfter] が true の場合、最後のアイテムの後に広告を表示するようにマークする。
  void _addRepliesToView(List<ReplyItem> items, {bool showAdAfter = false}) {
    if (items.isEmpty) return;
    for (int i = 0; i < items.length; i++) {
      final item = items[i];
      final int displayNumber = replies.length + 1;
      ReplyItem finalItem = item;

      if (item.origin == ReplyOrigin.sharedAi) {
        final int sharedIndex = _sharedReplies.length + 1;
        _sharedReplies.add(item);
        _sharedIndexToDisplayNumber[sharedIndex] = displayNumber;

        if (item.replyTo != null) {
          final mapped = _sharedIndexToDisplayNumber[item.replyTo!];
          if (mapped != null) {
            finalItem = item.copyWith(replyTo: mapped);
          }
        }
      }

      replies.add(finalItem);
      if (showAdAfter && i == items.length - 1) {
        threadAds.addNormalAdAt(
          replies.length - 1,
          sharedGenerationId:
              _sharedGenerationIds[(_sharedReplies.length + 9) ~/ 10],
        );
      }
    }
    _safeNotifyListeners();
  }

  Future<void> loadInitialReplies() async {
    if (isLoading || replies.isNotEmpty) return;
    isLoading = true;
    _sharedLoadingMessage = _pickRandomMessage(_sharedLoadingMessages);
    threadAds.addTopAd();
    _safeNotifyListeners();

    if (isSaved) {
      await _restoreSavedArchive();
      if (_disposed) return;
      if (replies.isNotEmpty || isReadOnly) {
        isLoading = false;
        _sharedLoadingMessage = null;
        _safeNotifyListeners();
        return;
      }
    }

    if (!isSaved) {
      try {
        final cacheData = await ReplyCacheService.loadReplies(newsUrl: newsUrl);
        if (_disposed) return;

        if (cacheData != null) {
          final List<ReplyItem> cachedReplies =
              (cacheData['replies'] as List<dynamic>)
                  .map((r) => ReplyItem.fromJson(r as Map<String, dynamic>))
                  .toList();
          dbReplyCount = cacheData['dbReplyCount'] as int;
          initialDbReplyCount = dbReplyCount;
          final cachedConversations =
              cacheData['chunkConversations'] as Map<int, ConversationPlan?>;
          for (final entry in cachedConversations.entries) {
            final conversation = entry.value;
            if (conversation != null) {
              _chunkConversations[entry.key] = conversation;
            }
          }
          for (int offset = 0; offset < cachedReplies.length; offset += 10) {
            final chunkIndex = (offset ~/ 10) + 1;
            _chunkReplyCounts[chunkIndex] = min(
              10,
              cachedReplies.length - offset,
            );
          }

          if (cachedReplies.isNotEmpty) {
            final initialCount = min(10, cachedReplies.length);
            _addRepliesToView(
              cachedReplies.take(initialCount).toList(),
              showAdAfter: true,
            );
            _cachedQueue.addAll(cachedReplies.skip(initialCount));
            isLoading = false;
            ReplyCacheService.updateLastAccessedAt(newsUrl: newsUrl);
            return;
          }
        }
      } catch (e) {
        debugPrint('[Thread] レスキャッシュ読込エラー: $e');
      }
    }

    initialGeneration = true;
    for (int i = 0; i < 30; i++) {
      if (articleBody.isNotEmpty) break;
      await Future.delayed(const Duration(milliseconds: 200));
    }

    try {
      final chunk = await _getOrGenerateSharedChunk(1);
      if (_disposed) return;

      if (chunk != null) {
        _addRepliesToView(chunk.replies, showAdAfter: true);
        await _persistArchive();
      }
    } catch (e) {
      _loadMoreErrorMessage = _pickRandomMessage(sharedErrorMessages);
      debugPrint('[SharedChunk] initial failed type=${e.runtimeType}');
    } finally {
      isLoading = false;
      _sharedLoadingMessage = null;
      _safeNotifyListeners();
    }
  }

  /// 共有AIチャンクを取得または生成する。二重実行を防ぐ。
  Future<CachedReplyChunk?> _getOrGenerateSharedChunk(int chunkIndex) async {
    if (_loadingChunks.contains(chunkIndex)) return null;
    _loadingChunks.add(chunkIndex);

    _sharedLoadingMessage = _pickRandomMessage(_sharedLoadingMessages);
    _safeNotifyListeners();

    final totalStopwatch = Stopwatch()..start();
    try {
      // 1. DB確認
      final cacheStopwatch = Stopwatch()..start();
      debugPrint('[SharedChunk] cache start chunk=$chunkIndex');
      final dbChunk = await ReplyCacheService.loadChunk(
        newsUrl: newsUrl,
        chunkIndex: chunkIndex,
      );
      debugPrint(
        '[SharedChunk] cache end chunk=$chunkIndex '
        'result=${dbChunk == null ? 'MISS' : 'HIT'} '
        'elapsedMs=${cacheStopwatch.elapsedMilliseconds}',
      );
      if (_disposed) return null;

      if (dbChunk != null && dbChunk.replies.isNotEmpty) {
        _registerChunkConversation(chunkIndex, dbChunk);
        _loadingChunks.remove(chunkIndex);
        return dbChunk;
      }

      // 2. 生成
      isGenerating = true;
      _safeNotifyListeners();
      if (chunkIndex == 1 && topicId != null) {
        final deadline = DateTime.now().add(const Duration(seconds: 40));
        while (!_disposed && DateTime.now().isBefore(deadline)) {
          final result =
              await (sharedInitialRequester?.call(topicId!) ??
                  AiService.requestSharedInitial(topicId: topicId!));
          if (_disposed) return null;
          switch (result.status) {
            case SharedInitialStatus.ready:
              final savedChunk = await ReplyCacheService.loadChunk(
                newsUrl: newsUrl,
                chunkIndex: 1,
              );
              if (_disposed) return null;
              if (savedChunk == null || savedChunk.replies.length != 10) {
                throw StateError('ready shared chunk is missing');
              }
              _registerChunkConversation(1, savedChunk);
              return savedChunk;
            case SharedInitialStatus.running:
              await Future<void>.delayed(const Duration(seconds: 1));
              break;
            case SharedInitialStatus.deferred:
            case SharedInitialStatus.exhausted:
              _loadMoreErrorMessage = '共有AIの生成枠が現在利用できません。時間をおいて再試行してください。';
              return null;
          }
        }
        if (!_disposed) {
          _loadMoreErrorMessage = 'AIレスの生成に時間がかかっています。再試行してください。';
        }
        return null;
      }
      final generationStopwatch = Stopwatch()..start();
      debugPrint('[SharedChunk] generation start chunk=$chunkIndex');

      final conversation = ConversationPlan.generate(
        count: 10,
        random: _random,
      );
      final List<ReplyItem> context = _sharedReplies.length > 30
          ? _sharedReplies.sublist(_sharedReplies.length - 30)
          : List<ReplyItem>.from(_sharedReplies);

      await AiService.generateReplies(
        onGenerationStarted: (id) {
          _sharedGenerationIds[chunkIndex] = id;
        },
        newsTitle: articleTitle,
        articleBody: articleBody,
        topicSubject: topicSubject,
        topicEvent: topicEvent,
        topicFacts: topicFacts,
        topicThreadTitle: topicThreadTitle,
        useTopicContext:
            topicCreationMode != 'gemma_failed' &&
            topicSubject != null &&
            topicEvent != null,
        replyRelations: conversation.relations,
        count: 10,
        context: context,
        articleUrl: newsUrl,
        chunkIndex: chunkIndex,
        conversationPattern: conversation.pattern.name,
      );
      debugPrint(
        '[SharedChunk] generation end chunk=$chunkIndex '
        'elapsedMs=${generationStopwatch.elapsedMilliseconds}',
      );
      if (_disposed) return null;
      final persistedChunk = await ReplyCacheService.loadChunk(
        newsUrl: newsUrl,
        chunkIndex: chunkIndex,
      );
      if (persistedChunk == null || persistedChunk.replies.length != 10) {
        throw StateError('server-saved shared chunk is missing');
      }
      _registerChunkConversation(chunkIndex, persistedChunk);
      return persistedChunk;
    } catch (e) {
      debugPrint(
        '[SharedChunk] failed chunk=$chunkIndex type=${e.runtimeType} '
        'elapsedMs=${totalStopwatch.elapsedMilliseconds}',
      );
      rethrow;
    } finally {
      isGenerating = false;
      _sharedLoadingMessage = null;
      _loadingChunks.remove(chunkIndex);
      debugPrint(
        '[SharedChunk] finished chunk=$chunkIndex '
        'elapsedMs=${totalStopwatch.elapsedMilliseconds}',
      );
      _safeNotifyListeners();
    }
  }

  Future<void> loadMoreReplies() async {
    if (isLoading ||
        isGenerating ||
        isReadOnly ||
        _loadMoreErrorMessage != null) {
      return;
    }

    if (_cachedQueue.isNotEmpty) {
      isLoading = true;
      _sharedLoadingMessage = _pickRandomMessage(_sharedLoadingMessages);
      _safeNotifyListeners();
      try {
        final nextCount = min(10, _cachedQueue.length);
        final nextItems = _cachedQueue.take(nextCount).toList();
        _cachedQueue.removeRange(0, nextCount);
        _addRepliesToView(nextItems, showAdAfter: true);
      } finally {
        isLoading = false;
        _sharedLoadingMessage = null;
        _safeNotifyListeners();
      }
      return;
    }

    if (!await _ensureServerThreadAvailable()) return;

    isLoading = true;
    _sharedLoadingMessage = _pickRandomMessage(_sharedLoadingMessages);
    _safeNotifyListeners();

    final stopwatch = Stopwatch()..start();
    final int nextSharedChunkIndex = (_sharedReplies.length / 10).floor() + 1;
    debugPrint('[SharedThread] load start chunk=$nextSharedChunkIndex');
    try {
      final chunk =
          await (sharedChunkLoader?.call(nextSharedChunkIndex) ??
              _getOrGenerateSharedChunk(nextSharedChunkIndex));
      if (_disposed) return;

      if (chunk != null) {
        _addRepliesToView(chunk.replies, showAdAfter: true);
        await _persistArchive();
      }
      debugPrint(
        '[SharedThread] load end chunk=$nextSharedChunkIndex '
        'elapsedMs=${stopwatch.elapsedMilliseconds}',
      );
    } catch (e) {
      _loadMoreErrorMessage = _pickRandomMessage(sharedErrorMessages);
      debugPrint(
        '[SharedThread] load failed chunk=$nextSharedChunkIndex '
        'type=${e.runtimeType} elapsedMs=${stopwatch.elapsedMilliseconds}',
      );
    } finally {
      isLoading = false;
      _sharedLoadingMessage = null;
      _safeNotifyListeners();
    }
  }

  Future<void> retryLoadMoreReplies() async {
    if (isLoading || isGenerating) return;
    _loadMoreErrorMessage = null;
    await loadMoreReplies();
  }

  Future<bool> postComment(String originalText) async {
    if (originalText.trim().isEmpty ||
        isLoading ||
        isGenerating ||
        isReadOnly) {
      return false;
    }

    if (!InputLimitUtils.isValidLength(originalText)) {
      return false;
    }

    if (!await _ensureServerThreadAvailable()) return false;

    final analysis = ReplySubmissionAnalysis.analyze(originalText);

    final referencedReply = analysis.referencedNumber != null
        ? findReferencedReply(analysis.referencedNumber!)
        : null;

    isLoading = true;
    _safeNotifyListeners();

    try {
      _recordCurrentChunkEvent(AiChunkEngagementEvent.userPost);

      // 1. userアイテム作成 (即時表示用)
      final contributionId = newMeasurementId();
      MonetizationAnalyticsService.instance.record(
        'contribution',
        contributionId,
        {
          'contributionId': contributionId,
          'threadSessionId': threadAds.sessionId,
        },
      );
      final userItem = ReplyItem(
        text: analysis.bodyForDisplay,
        type: ReplyType.user,
        name: '自分',
        id: randomId(), // トラッキング用に一意なID
        replyTo: analysis.referencedNumber,
        origin: ReplyOrigin.user,
      );

      // 2. 即座に追加
      final int userIndex = replies.length;
      replies.add(userItem);

      _safeNotifyListeners();
      await _persistArchive();

      // 即ジャンプ
      final int userReplyNumber = userIndex + 1;
      debugPrint(
        '[ThreadPost] user appended immediately reply=$userReplyNumber',
      );
      requestJump(userReplyNumber, sourceNumber: null);

      // 広告の管理：
      threadAds.handlePostContribution(
        userIndex,
        contributionId: contributionId,
      );
      if (_adPolicy.hasAdAt(userIndex)) {
        debugPrint('[ThreadAd] post ad updated for user=$userIndex');
      } else {
        debugPrint(
          '[ThreadAd] post ad skipped (interval since last ad is too short)',
        );
      }

      // 3. AI返信の要否判定
      if (analysis.shouldGenerateAiReply) {
        // 3系統判定
        if (referencedReply != null && referencedReply.type == ReplyType.ai) {
          _generatingUserMessages[userItem.id] = _pickRandomMessage(
            _specificReplyMessages,
          );
        } else {
          _generatingUserMessages[userItem.id] = _pickRandomMessage(
            _userReplyMessages,
          );
        }

        _safeNotifyListeners();

        // 非同期でAI生成開始 (awaitしない)
        _generateLocalAiRepliesInBackground(
          contributionId: contributionId,
          userItem: userItem,
          userComment: analysis.bodyForCheck, // プロンプト用には正規化された本文を渡す
          referencedReply: referencedReply,
        );
      }
      return true;
    } catch (e) {
      debugPrint('[Thread] 投稿処理エラー: $e');
      return false;
    } finally {
      isLoading = false;
      _safeNotifyListeners();
    }
  }

  /// バックグラウンドでLocalAI返信を生成し、対象userレスの直後（広告の下）へ挿入する
  Future<void> _generateLocalAiRepliesInBackground({
    required String contributionId,
    required ReplyItem userItem,
    required String userComment,
    ReplyItem? referencedReply,
  }) async {
    debugPrint('[ThreadPost] generating localAi for user=${userItem.id}');

    try {
      final effectiveUserComment = userComment.isEmpty
          ? ">>${userItem.replyTo}"
          : userComment;

      List<ReplyItem> localAiReplies = [];
      if (referencedReply != null && referencedReply.type == ReplyType.ai) {
        // AIへの返信
        final texts = await AiService.generateReplyToSpecificUser(
          contributionId: contributionId,
          onGenerationStarted: (id) =>
              threadAds.linkLocalGeneration(contributionId, id),
          newsTitle: articleTitle,
          articleBody: articleBody,
          targetReplyText: referencedReply.text,
          userComment: effectiveUserComment,
        );
        if (_disposed) return;

        if (texts.isNotEmpty) {
          localAiReplies.add(
            _createAiReply(
              text: texts.first,
              id: referencedReply.id, // IDを引き継ぐ
              replyTo: null, // 後で設定
              origin: ReplyOrigin.localAi,
            ),
          );
        }
      } else {
        // 通常の返信
        final directReplyCount = 2 + _random.nextInt(2);
        final texts = await AiService.generateUserReplies(
          contributionId: contributionId,
          onGenerationStarted: (id) =>
              threadAds.linkLocalGeneration(contributionId, id),
          newsTitle: articleTitle,
          articleBody: articleBody,
          userComment: userComment,
          replyCount: directReplyCount,
        );
        if (_disposed) return;

        localAiReplies = _createAiItems(
          texts: texts,
          replyTo: null, // 後で設定
          origin: ReplyOrigin.localAi,
        );
      }

      if (localAiReplies.isEmpty) {
        _generatingUserMessages.remove(userItem.id);
        _safeNotifyListeners();
        return;
      }

      // 挿入位置の特定 (ユーザー投稿の直後)
      // 生成中に sharedAi 等が追加されている可能性があるため ID で探す
      int userIdx = replies.indexWhere((r) => r.id == userItem.id);
      if (userIdx == -1) {
        userIdx = replies.length - 1; // 万が一見つからない場合は末尾
      }

      final int userReplyNumber = userIdx + 1;

      // replyTo をユーザー投稿の番号に設定し、アイテムを確定
      final List<ReplyItem> finalItems = localAiReplies
          .map((r) => r.copyWith(replyTo: userReplyNumber))
          .toList();

      // 挿入 (user直後)
      replies.insertAll(userIdx + 1, finalItems);

      // 広告インデックスの調整
      threadAds.shiftAdsAfter(userIdx, finalItems.length);

      _generatingUserMessages.remove(userItem.id);
      await _persistArchive();
      debugPrint(
        '[ThreadPost] localAi inserted after user=$userReplyNumber count=${finalItems.length}',
      );
      _safeNotifyListeners();
    } catch (e) {
      debugPrint('[Thread] LocalAI生成エラー: $e');
      _generatingUserMessages.remove(userItem.id);
      _safeNotifyListeners();
    }
  }

  Future<bool> deleteUserComment(int displayNumber) async {
    if (displayNumber < 1 || displayNumber > replies.length) return false;
    final index = displayNumber - 1;
    final reply = replies[index];
    if (reply.origin != ReplyOrigin.user || reply.isDeleted) return false;

    replies[index] = reply.copyWith(isDeleted: true);
    _safeNotifyListeners();
    await _persistArchive();
    return true;
  }

  Future<void> _restoreSavedArchive() async {
    try {
      _archive = await archiveLoader(newsUrl);
      final archive = _archive;
      if (archive == null) return;
      isReadOnly = archive.isReadOnly;
      if (archive.replies.isEmpty) return;

      replies.addAll(archive.replies);
      final displayToShared = <int, int>{};
      var sharedIndex = 0;
      for (var index = 0; index < replies.length; index++) {
        if (replies[index].origin == ReplyOrigin.sharedAi) {
          sharedIndex++;
          displayToShared[index + 1] = sharedIndex;
          _sharedIndexToDisplayNumber[sharedIndex] = index + 1;
          if (sharedIndex % 10 == 0) {
            threadAds.addNormalAdAt(index);
          }
        }
      }

      for (final reply in replies.where(
        (reply) => reply.origin == ReplyOrigin.sharedAi,
      )) {
        _sharedReplies.add(
          ReplyItem(
            text: reply.text,
            type: reply.type,
            name: reply.name,
            id: reply.id,
            replyTo: reply.replyTo == null
                ? null
                : displayToShared[reply.replyTo!],
            origin: reply.origin,
            reportTargetId: reply.reportTargetId,
          ),
        );
      }

      dbReplyCount = _sharedReplies.length;
      initialDbReplyCount = dbReplyCount;
      final chunkCount = archive.loadedSharedChunkCount > 0
          ? archive.loadedSharedChunkCount
          : (_sharedReplies.length / 10).ceil();
      for (var chunk = 1; chunk <= chunkCount; chunk++) {
        final remaining = _sharedReplies.length - ((chunk - 1) * 10);
        if (remaining <= 0) break;
        _chunkReplyCounts[chunk] = min(10, remaining);
      }
    } catch (e) {
      debugPrint('[Thread] 保存スレッド復元エラー: $e');
    }
  }

  Future<void> _persistArchive() async {
    if (!isSaved) return;
    final article =
        _archive?.article ??
        NewsItem(
          title: articleTitle,
          description: articleBody,
          url: newsUrl,
          category: sourceName,
          time: '',
          feedUrl: '',
        );
    _archive = SavedThreadArchive(
      article: article,
      replies: List<ReplyItem>.from(replies),
      loadedSharedChunkCount: (_sharedReplies.length / 10).ceil(),
      isReadOnly: isReadOnly,
    );
    try {
      await archiveSaver(_archive!);
    } catch (e) {
      debugPrint('[Thread] 保存スレッド永続化エラー: $e');
    }
  }

  Future<bool> _ensureServerThreadAvailable() async {
    if (!isSaved || _sharedReplies.isEmpty) return true;
    if (isReadOnly) return false;
    final status = await serverThreadChecker(newsUrl);
    if (status != ServerThreadStatus.notFound) return true;

    isReadOnly = true;
    _loadMoreErrorMessage = null;
    _sharedLoadingMessage = null;
    await _persistArchive();
    _safeNotifyListeners();
    return false;
  }

  void _registerChunkConversation(int chunkIndex, CachedReplyChunk chunk) {
    _chunkReplyCounts[chunkIndex] = chunk.replies.length;
    final conversation = chunk.conversation;
    if (conversation == null) return;
    _chunkConversations[chunkIndex] = conversation;
    if (kDebugMode) {
      final relations = conversation.relations
          .map((relation) => '${relation.from}->${relation.to}')
          .join(',');
      debugPrint(
        '[AIConversation] chunk=$chunkIndex '
        'pattern=${conversation.pattern.name} '
        'density=${conversation.densityFor(chunk.replies.length).toStringAsFixed(2)} '
        'relations=$relations',
      );
    }
  }

  /// 実スクロール時の可視率から境界イベントと投稿帰属先を更新する。
  void recordVisibleReplies(Map<int, double> visibleFractions) {
    final chunkVisibleFractions = <int, double>{};
    for (final entry in visibleFractions.entries) {
      final chunkPosition = _sharedChunkPositionForDisplay(entry.key);
      if (chunkPosition == null || entry.value <= 0) continue;
      final (chunkIndex, position) = chunkPosition;
      chunkVisibleFractions[chunkIndex] =
          (chunkVisibleFractions[chunkIndex] ?? 0) + entry.value;
      if (entry.value >= 0.5) {
        if (position == 1) {
          _recordChunkEvent(chunkIndex, AiChunkEngagementEvent.chunkStart);
        }
        if (position == _chunkReplyCounts[chunkIndex]) {
          _recordChunkEvent(chunkIndex, AiChunkEngagementEvent.chunkEnd);
        }
      }
    }

    int? selectedChunk;
    double selectedFraction = -1;
    for (final entry in chunkVisibleFractions.entries) {
      final replyCount = _chunkReplyCounts[entry.key];
      if (replyCount == null || replyCount == 0) continue;
      final chunkFraction = entry.value / replyCount;
      if (chunkFraction > selectedFraction ||
          (chunkFraction == selectedFraction &&
              (selectedChunk == null || entry.key > selectedChunk))) {
        selectedChunk = entry.key;
        selectedFraction = chunkFraction;
      }
    }
    _currentlyViewedChunk = selectedChunk;
  }

  void recordAnchorTap(int displayNumber) {
    final chunkPosition = _sharedChunkPositionForDisplay(displayNumber);
    if (chunkPosition == null) return;
    _recordChunkEvent(chunkPosition.$1, AiChunkEngagementEvent.anchorTap);
  }

  (int, int)? _sharedChunkPositionForDisplay(int displayNumber) {
    if (displayNumber < 1 || displayNumber > replies.length) return null;
    if (replies[displayNumber - 1].origin != ReplyOrigin.sharedAi) return null;
    int sharedIndex = 0;
    for (int i = 0; i < displayNumber; i++) {
      if (replies[i].origin == ReplyOrigin.sharedAi) sharedIndex++;
    }
    return (((sharedIndex - 1) ~/ 10) + 1, ((sharedIndex - 1) % 10) + 1);
  }

  void _recordCurrentChunkEvent(AiChunkEngagementEvent event) {
    final chunkIndex = _currentlyViewedChunk;
    if (chunkIndex != null) _recordChunkEvent(chunkIndex, event);
  }

  void _recordChunkEvent(int chunkIndex, AiChunkEngagementEvent event) {
    final conversation = _chunkConversations[chunkIndex];
    final replyCount = _chunkReplyCounts[chunkIndex];
    if (conversation == null || replyCount == null || replyCount == 0) return;
    unawaited(
      AiChunkAnalyticsService.record(
        newsUrl: newsUrl,
        chunkIndex: chunkIndex,
        conversation: conversation,
        replyCount: replyCount,
        event: event,
        category: newsCategory,
      ),
    );
  }
}
