import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/conversation_pattern.dart';
import 'package:news_app/models/reply_item.dart';

void main() {
  group('Shared AI Error Message Tests', () {
    test('1. ランダム表示の候補が15種類であることのテスト', () {
      final messages = NewsDetailController.sharedErrorMessages;
      expect(messages.length, 15);

      final expectedMessages = [
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

      expect(messages, equals(expectedMessages));
      // 重複がないことも確認
      expect(messages.toSet().length, 15);
    });

    test('2. エラー発生時に15種類からランダムに1つ選択されるテスト', () async {
      final controller = NewsDetailController(
        articleTitle: 'title',
        articleBody: 'body',
        newsUrl: 'https://example.com/article',
        sharedChunkLoader: (_) => throw Exception('failed'),
      );

      await controller.loadMoreReplies();
      expect(controller.loadMoreErrorMessage, isNotNull);
      expect(
        NewsDetailController.sharedErrorMessages.contains(
          controller.loadMoreErrorMessage,
        ),
        isTrue,
      );

      controller.dispose();
    });

    test('3. 再描画（notifyListeners）時に文言が維持されることのテスト', () async {
      final controller = NewsDetailController(
        articleTitle: 'title',
        articleBody: 'body',
        newsUrl: 'https://example.com/article',
        sharedChunkLoader: (_) => throw Exception('failed'),
      );

      await controller.loadMoreReplies();
      final initialMessage = controller.loadMoreErrorMessage;
      expect(initialMessage, isNotNull);

      // notifyListeners を意図的に呼び出して再描画をシミュレート
      bool notified = false;
      controller.addListener(() {
        notified = true;
      });

      // スクロールや画面更新を想定した状態変化の通知
      controller.notifyListeners();

      expect(notified, isTrue);
      expect(controller.loadMoreErrorMessage, equals(initialMessage));

      controller.dispose();
    });

    test('4. 再試行後に再び失敗した場合に改めてエラーメッセージが設定されるテスト', () async {
      final controller = NewsDetailController(
        articleTitle: 'title',
        articleBody: 'body',
        newsUrl: 'https://example.com/article',
        sharedChunkLoader: (_) => throw Exception('failed'),
      );

      await controller.loadMoreReplies();
      expect(controller.loadMoreErrorMessage, isNotNull);

      await controller.retryLoadMoreReplies();
      expect(controller.loadMoreErrorMessage, isNotNull);
      expect(
        NewsDetailController.sharedErrorMessages.contains(
          controller.loadMoreErrorMessage,
        ),
        isTrue,
      );

      controller.dispose();
    });

    test('5. 正常生成時にエラー表示が消えることの確認', () async {
      int attempts = 0;
      final controller = NewsDetailController(
        articleTitle: 'title',
        articleBody: 'body',
        newsUrl: 'https://example.com/article',
        sharedChunkLoader: (_) async {
          attempts++;
          if (attempts == 1) {
            throw Exception('failed');
          }
          return CachedReplyChunk(
            replies: List.generate(
              10,
              (i) => ReplyItem(
                text: 'text $i',
                type: ReplyType.ai,
                name: 'name',
                id: 'id_$i',
              ),
            ),
            conversation: const ConversationPlan(
              pattern: ConversationPattern.independent,
              relations: [],
            ),
          );
        },
      );

      await controller.loadMoreReplies();
      expect(controller.loadMoreErrorMessage, isNotNull);

      await controller.retryLoadMoreReplies();
      expect(controller.loadMoreErrorMessage, isNull);
      expect(controller.replies, hasLength(10));

      controller.dispose();
    });
  });
}
