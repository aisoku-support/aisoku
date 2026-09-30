import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/widgets/news_detail_reply_input.dart';

void main() {
  testWidgets('generation disables submit and preserves the draft', (
    tester,
  ) async {
    final textController = TextEditingController(text: '入力途中の文章');
    int submitCount = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              NewsDetailReplyInput(
                controller: textController,
                onSubmit: () => submitCount++,
                onTapOutside: () {},
                isSubmitEnabled: false,
                disabledMessage: 'AIが返信を生成しています。完了後に送信できます',
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('AIが返信を生成しています。完了後に送信できます'), findsOneWidget);
    expect(
      tester.widget<IconButton>(find.byType(IconButton)).onPressed,
      isNull,
    );
    await tester.tap(find.byIcon(Icons.send), warnIfMissed: false);
    expect(submitCount, 0);
    expect(textController.text, '入力途中の文章');

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              NewsDetailReplyInput(
                controller: textController,
                onSubmit: () => submitCount++,
                onTapOutside: () {},
                isSubmitEnabled: true,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.tap(find.byIcon(Icons.send));
    expect(submitCount, 1);
    expect(textController.text, '入力途中の文章');

    textController.dispose();
  });

  test('controller rejects a post while generation is active', () async {
    final controller = NewsDetailController(
      articleTitle: 'title',
      articleBody: 'body',
      newsUrl: 'https://example.com/article',
    );
    controller.isGenerating = true;

    await controller.postComment('送信されない下書き');

    expect(controller.replies, isEmpty);
    controller.dispose();
  });
}
