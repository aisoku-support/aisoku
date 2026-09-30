import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/conversation_pattern.dart';

enum AiChunkEngagementEvent { chunkStart, chunkEnd, anchorTap, userPost }

class AiChunkAnalyticsService {
  static final String _sessionId = _createSessionId();
  static final Set<String> _sentEvents = {};

  static Future<void> record({
    required String newsUrl,
    required int chunkIndex,
    required ConversationPlan conversation,
    required int replyCount,
    required AiChunkEngagementEvent event,
    String? category,
  }) async {
    final eventType = switch (event) {
      AiChunkEngagementEvent.chunkStart => 'chunk_start',
      AiChunkEngagementEvent.chunkEnd => 'chunk_end',
      AiChunkEngagementEvent.anchorTap => 'anchor_tap',
      AiChunkEngagementEvent.userPost => 'user_post',
    };
    final dedupeKey = '$newsUrl|$chunkIndex|$eventType';
    if (!_sentEvents.add(dedupeKey)) return;
    final density = conversation.densityFor(replyCount);

    try {
      await Supabase.instance.client.rpc(
        'record_ai_chunk_engagement',
        params: {
          'p_session_id': _sessionId,
          'p_news_url': newsUrl,
          'p_chunk_index': chunkIndex,
          'p_event_type': eventType,
          'p_category': category,
        },
      );
      if (kDebugMode) {
        debugPrint(
          '[AIAnalytics] event=$eventType article=${newsUrl.hashCode} '
          'chunk=$chunkIndex pattern=${conversation.pattern.name} '
          'density=${density.toStringAsFixed(2)}',
        );
      }
    } catch (error) {
      if (kDebugMode) {
        debugPrint('[AIAnalytics] send failed event=$eventType: $error');
      }
    }
  }

  static String _createSessionId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes.map((value) => value.toRadixString(16).padLeft(2, '0'));
    final value = hex.join();
    return '${value.substring(0, 8)}-'
        '${value.substring(8, 12)}-'
        '${value.substring(12, 16)}-'
        '${value.substring(16, 20)}-'
        '${value.substring(20)}';
  }
}
