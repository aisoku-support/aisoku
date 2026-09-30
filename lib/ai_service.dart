import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'models/conversation_pattern.dart';
import 'models/reply_item.dart';
import 'models/ad_identity.dart';
import 'services/monetization_analytics_service.dart';

class AiService {
  static const Duration _requestTimeout = Duration(seconds: 45);
  static const Duration _sharedInitialRequestTimeout = Duration(seconds: 10);

  static Future<void>? _initFuture;

  /// Supabase初期化Futureを設定する
  static void setInitFuture(Future<void> future) {
    _initFuture = future;
  }

  /// Supabaseクライアントを取得する。初期化完了を待機する。
  static Future<SupabaseClient> get _client async {
    if (_initFuture != null) {
      await _initFuture;
    }
    return Supabase.instance.client;
  }

  static const String _model = 'gemini-3.5-flash-lite';

  /// 初回Topic共有チャンクのサーバー側生成状態。
  static Future<SharedInitialResult> requestSharedInitial({
    required String topicId,
  }) async {
    if (topicId.trim().isEmpty) throw const FormatException('invalid topic id');
    final client = await _client;
    final FunctionResponse response;
    try {
      response = await client.functions
          .invoke(
            'generate-ai-replies',
            body: {'mode': 'sharedInitial', 'topicId': topicId},
          )
          .timeout(_sharedInitialRequestTimeout);
    } on FunctionException catch (error) {
      throw AiServiceException(statusCode: error.status);
    }
    if (response.status != 200 && response.status != 202) {
      throw AiServiceException(statusCode: response.status);
    }
    final data = response.data;
    if (data is! Map<String, dynamic>) {
      throw const FormatException('invalid sharedInitial response');
    }
    final status = switch (data['status']) {
      'ready' => SharedInitialStatus.ready,
      'running' => SharedInitialStatus.running,
      'deferred' => SharedInitialStatus.deferred,
      'exhausted' => SharedInitialStatus.exhausted,
      _ => throw const FormatException('invalid sharedInitial status'),
    };
    return SharedInitialResult(status: status);
  }

  /// 通常の共有AIチャンク（10件）を生成する
  static Future<List<String>> generateReplies({
    void Function(String)? onGenerationStarted,
    required String newsTitle,
    required String articleBody,
    String? topicSubject,
    String? topicEvent,
    List<String> topicFacts = const [],
    String? topicThreadTitle,
    bool useTopicContext = false,
    required List<ReplyRelation> replyRelations,
    int count = 10,
    List<ReplyItem> context = const [],
    String? articleUrl,
    int? chunkIndex,
    String? conversationPattern,
  }) async {
    final sharedContext = context
        .where((r) => r.origin == ReplyOrigin.sharedAi)
        .toList();

    final limitedContext = sharedContext.length > 30
        ? sharedContext.sublist(sharedContext.length - 30)
        : sharedContext;

    final body = {
      'mode': 'sharedAi',
      'newsTitle': _truncate(newsTitle, 300),
      'articleBody': _truncate(articleBody, 12000),
      'count': count,
      'topicSubject': _truncate(topicSubject, 300),
      'topicEvent': _truncate(topicEvent, 400),
      'topicFacts': topicFacts
          .map((f) => _truncate(f, 500))
          .where((f) => f.isNotEmpty)
          .take(40)
          .toList(),
      'topicThreadTitle':
          topicThreadTitle == null || topicThreadTitle.trim().isEmpty
          ? null
          : _truncate(topicThreadTitle, 300),
      'useTopicContext': useTopicContext,
      'replyRelations': replyRelations
          .map((r) => {'from': r.from, 'to': r.to})
          .toList(),
      'context': limitedContext
          .map((r) => _truncate(r.text, 1000))
          .where((t) => t.isNotEmpty)
          .toList(),
      if (articleUrl != null &&
          chunkIndex != null &&
          conversationPattern != null) ...{
        'articleUrl': articleUrl,
        'chunkIndex': chunkIndex,
        'conversationPattern': conversationPattern,
      },
    };

    return _postToEdge(
      body: body,
      expectedCount: count,
      generationType: 'sharedAi',
      onGenerationStarted: onGenerationStarted,
    );
  }

  static String _truncate(String? text, int max) {
    if (text == null) return '';
    final trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    return trimmed.substring(0, max);
  }

  static Future<List<String>> _postToEdge({
    required Map<String, dynamic> body,
    required int expectedCount,
    required String generationType,
    void Function(String)? onGenerationStarted,
    String? contributionId,
  }) async {
    final stopwatch = Stopwatch()..start();
    final generationId = newMeasurementId();
    final measurement = <String, Object?>{
      'generationId': generationId,
      'model': _model,
      'generationType': generationType,
      'contributionId': contributionId,
      'inputTokens': null,
      'outputTokens': null,
      'apiCost': null,
      'costCurrency': null,
      'success': null,
    };
    onGenerationStarted?.call(generationId);
    MonetizationAnalyticsService.instance.record(
      'generation_started',
      generationId,
      measurement,
    );

    try {
      final client = await _client;
      final response = await client.functions
          .invoke(
            'generate-ai-replies',
            body: body,
            headers: {'x-ai-diagnostic-id': generationId},
          )
          .timeout(_requestTimeout);

      if (response.status != 200) {
        debugPrint(
          '[AiService] Edge request failed status=${response.status} '
          'elapsedMs=${stopwatch.elapsedMilliseconds}',
        );
        throw AiServiceException(statusCode: response.status);
      }

      final data = response.data as Map<String, dynamic>;
      final replies = data['replies'] as List<dynamic>?;

      if (replies == null || replies.isEmpty) {
        throw Exception('Edge Functionから回答がありませんでした');
      }

      final texts = replies
          .map((item) => item?.toString().trim() ?? '')
          .where((text) => text.isNotEmpty)
          .take(expectedCount)
          .toList();

      if (texts.isEmpty) {
        throw Exception('Edge Functionから有効なレスが生成されませんでした');
      }

      measurement['success'] = true;

      debugPrint(
        '[AiService] Edge request completed '
        'diagnosticId=$generationId '
        'elapsedMs=${stopwatch.elapsedMilliseconds}',
      );
      return texts;
    } on TimeoutException {
      debugPrint(
        '[AiService] Edge request timed out '
        'diagnosticId=$generationId '
        'elapsedMs=${stopwatch.elapsedMilliseconds}',
      );
      throw const AiServiceException(timedOut: true);
    } catch (e) {
      if (e is FunctionException) {
        final details = e.details;
        final candidateId = details is Map ? details['diagnosticId'] : null;
        final diagnosticId =
            candidateId is String &&
                RegExp(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  caseSensitive: false,
                ).hasMatch(candidateId)
            ? candidateId
            : null;
        debugPrint(
          '[AiService] Edge request failed status=${e.status} '
          'diagnosticId=${diagnosticId ?? generationId} '
          'elapsedMs=${stopwatch.elapsedMilliseconds}',
        );
      } else {
        debugPrint(
          '[AiService] Edge request failed type=${e.runtimeType} '
          'elapsedMs=${stopwatch.elapsedMilliseconds}',
        );
      }
      rethrow;
    } finally {
      measurement['success'] ??= false;
      MonetizationAnalyticsService.instance.record(
        'generation_completed',
        generationId,
        measurement,
      );
    }
  }

  /// 通常のユーザー投稿に対するAI返信（2〜3件）を生成する
  static Future<List<String>> generateUserReplies({
    void Function(String)? onGenerationStarted,
    String? contributionId,
    required String newsTitle,
    required String articleBody,
    required String userComment,
    int replyCount = 3,
  }) async {
    final body = {
      'mode': 'userReply',
      'newsTitle': _truncate(newsTitle, 300),
      'articleBody': _truncate(articleBody, 12000),
      'count': replyCount,
      'userComment': _truncate(userComment, 1000),
    };

    return _postToEdge(
      body: body,
      expectedCount: replyCount,
      generationType: 'localAi',
      onGenerationStarted: onGenerationStarted,
      contributionId: contributionId,
    );
  }

  /// 特定のAIレスへの返信（同一住人としての返信1件）を生成する
  static Future<List<String>> generateReplyToSpecificUser({
    void Function(String)? onGenerationStarted,
    String? contributionId,
    required String newsTitle,
    required String articleBody,
    required String targetReplyText,
    required String userComment,
  }) async {
    final body = {
      'mode': 'specificPersonReply',
      'newsTitle': _truncate(newsTitle, 300),
      'articleBody': _truncate(articleBody, 12000),
      'count': 1,
      'targetReplyText': _truncate(targetReplyText, 1000),
      'userComment': _truncate(userComment, 1000),
    };

    return _postToEdge(
      body: body,
      expectedCount: 1,
      generationType: 'localAi',
      onGenerationStarted: onGenerationStarted,
      contributionId: contributionId,
    );
  }
}

enum SharedInitialStatus { ready, running, deferred, exhausted }

class SharedInitialResult {
  const SharedInitialResult({required this.status});

  final SharedInitialStatus status;
}

class AiServiceException implements Exception {
  final int? statusCode;
  final bool timedOut;

  const AiServiceException({this.statusCode, this.timedOut = false});

  @override
  String toString() {
    if (timedOut) return 'AI request timed out';
    return 'AI request failed${statusCode == null ? '' : ' ($statusCode)'}';
  }
}
