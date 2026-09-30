import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/ai_service.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/conversation_pattern.dart';
import 'package:news_app/models/reply_item.dart';

void main() {
  group('loadMoreReplies failure recovery', () {
    test(
      '503 clears loading, blocks automatic retry, and allows manual retry',
      () async {
        int attempts = 0;
        final controller = NewsDetailController(
          articleTitle: 'title',
          articleBody: 'body',
          newsUrl: 'https://example.com/article',
          sharedChunkLoader: (_) async {
            attempts++;
            if (attempts == 1) {
              throw const AiServiceException(statusCode: 503);
            }
            return _chunk();
          },
        );

        await controller.loadMoreReplies();
        expect(controller.isLoading, isFalse);
        expect(controller.isGenerating, isFalse);
        expect(controller.loadMoreErrorMessage, isNotNull);
        expect(attempts, 1);

        await controller.loadMoreReplies();
        expect(attempts, 1);

        await controller.retryLoadMoreReplies();
        expect(attempts, 2);
        expect(controller.loadMoreErrorMessage, isNull);
        expect(controller.replies, hasLength(10));
        expect(controller.isLoading, isFalse);
        controller.dispose();
      },
    );

    test('timeout clears loading and exposes retry state', () async {
      final controller = NewsDetailController(
        articleTitle: 'title',
        articleBody: 'body',
        newsUrl: 'https://example.com/article',
        sharedChunkLoader: (_) => throw TimeoutException('timeout'),
      );

      await controller.loadMoreReplies();
      expect(controller.isLoading, isFalse);
      expect(controller.isGenerating, isFalse);
      expect(controller.loadMoreErrorMessage, isNotNull);
      controller.dispose();
    });
  });
}

CachedReplyChunk _chunk() {
  return CachedReplyChunk(
    replies: List.generate(
      10,
      (index) => ReplyItem(
        text: 'reply $index',
        type: ReplyType.ai,
        name: '名無しのAIさん',
        id: 'id-$index',
      ),
    ),
    conversation: const ConversationPlan(
      pattern: ConversationPattern.independent,
      relations: [],
    ),
  );
}
