import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/widgets/reply_card.dart';

void main() {
  group('user reply display', () {
    test('postComment preserves text following the anchor', () async {
      final controller = NewsDetailController(
        articleTitle: 'title',
        articleBody: 'body',
        newsUrl: 'https://example.com/article',
      );
      controller.replies.add(_reply(origin: ReplyOrigin.sharedAi));

      for (final input in ['>>1 あ', '>>1\nあ', '>>1\n\nあ']) {
        await controller.postComment(input);
        final posted = controller.replies.last;
        expect(posted.origin, ReplyOrigin.user);
        expect(posted.replyTo, 1);
        expect(posted.text, input.substring(3));
      }

      controller.dispose();
    });

    testWidgets('renders the anchor and original separator inline', (
      tester,
    ) async {
      int? tappedAnchor;
      for (final body in [' あ', '\nあ', '\n\nあ']) {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ReplyCard(
                number: 2,
                reply: _reply(origin: ReplyOrigin.user, replyTo: 1, text: body),
                onReply: () {},
                onAnchorTap: (target) => tappedAnchor = target,
              ),
            ),
          ),
        );

        final inlineText = tester
            .widgetList<Text>(find.byType(Text))
            .singleWhere((text) {
              final span = text.textSpan;
              return span is TextSpan &&
                  span.children?.firstOrNull is WidgetSpan;
            });
        final spans = (inlineText.textSpan! as TextSpan).children!;
        expect(spans, hasLength(2));
        expect((spans[1] as TextSpan).text, body);

        await tester.tap(find.text('>>1'));
        expect(tappedAnchor, 1);
      }
    });
  });

  group('reported reply display', () {
    testWidgets('hides the anchor when isReported is true', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 2,
              reply: _reply(origin: ReplyOrigin.sharedAi, replyTo: 1),
              onReply: () {},
              isReported: true,
            ),
          ),
        ),
      );

      // ">>1" というテキストが見つからないことを確認
      expect(find.textContaining('>>1'), findsNothing);
      // 通報済みメッセージが表示されていることを確認
      expect(find.text('コメントを通報しました'), findsOneWidget);
    });

    testWidgets('shows the anchor when isReported is false', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 2,
              reply: _reply(origin: ReplyOrigin.sharedAi, replyTo: 1),
              onReply: () {},
              isReported: false,
            ),
          ),
        ),
      );

      // ">>1" というテキストが表示されていることを確認
      expect(find.text('>>1'), findsOneWidget);
      // 本文が表示されていることを確認
      expect(find.text('本文'), findsOneWidget);
    });
  });

  group('copy behavior', () {
    testWidgets('copies only the report message when isReported is true', (
      tester,
    ) async {
      final reply = _reply(origin: ReplyOrigin.sharedAi, replyTo: 1);
      String? copiedText;

      // Clipboardのモック
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (methodCall) async {
          if (methodCall.method == 'Clipboard.setData') {
            copiedText = methodCall.arguments['text'];
          }
          return null;
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 2,
              reply: reply,
              onReply: () {},
              isReported: true,
            ),
          ),
        ),
      );

      // アクションメニューを開く
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      // コピーをタップ
      await tester.tap(find.text('コピー'));
      await tester.pumpAndSettle();

      expect(copiedText, 'コメントを通報しました');
      // 内部データが変更されていないことを確認
      expect(reply.text, '本文');
      expect(reply.replyTo, 1);
    });

    testWidgets('copies anchor and text when isReported is false', (
      tester,
    ) async {
      final reply = _reply(origin: ReplyOrigin.sharedAi, replyTo: 1);
      String? copiedText;

      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (methodCall) async {
          if (methodCall.method == 'Clipboard.setData') {
            copiedText = methodCall.arguments['text'];
          }
          return null;
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 2,
              reply: reply,
              onReply: () {},
              isReported: false,
            ),
          ),
        ),
      );

      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      await tester.tap(find.text('コピー'));
      await tester.pumpAndSettle();

      expect(copiedText, '>>1\n本文');
    });

    testWidgets('copies only the tombstone message when isDeleted is true', (
      tester,
    ) async {
      final reply = _reply(
        origin: ReplyOrigin.user,
        replyTo: 1,
        text: '元本文',
      ).copyWith(isDeleted: true);
      String? copiedText;

      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (methodCall) async {
          if (methodCall.method == 'Clipboard.setData') {
            copiedText = methodCall.arguments['text'];
          }
          return null;
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(number: 2, reply: reply, onReply: () {}),
          ),
        ),
      );

      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      await tester.tap(find.text('コピー'));
      await tester.pumpAndSettle();

      expect(copiedText, 'コメントを削除しました');
    });
  });

  group('user reply actions', () {
    testWidgets('shows reply, copy and delete without report', (tester) async {
      var deleted = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 1,
              reply: _reply(origin: ReplyOrigin.user),
              onReply: () {},
              onReport: () {},
              onDelete: () => deleted = true,
            ),
          ),
        ),
      );

      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      expect(find.text('返信'), findsOneWidget);
      expect(find.text('コピー'), findsOneWidget);
      expect(find.text('削除'), findsOneWidget);
      expect(find.text('通報'), findsNothing);

      await tester.tap(find.text('削除'));
      await tester.pumpAndSettle();
      expect(deleted, isTrue);
    });

    testWidgets('renders deleted body without its anchor', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 2,
              reply: _reply(
                origin: ReplyOrigin.user,
                replyTo: 1,
                text: '元本文',
              ).copyWith(isDeleted: true),
              onReply: () {},
            ),
          ),
        ),
      );

      expect(find.textContaining('>>1'), findsNothing);
      expect(find.text('コメントを削除しました'), findsOneWidget);
      expect(find.textContaining('元本文'), findsNothing);
    });
  });

  group('overflow prevention', () {
    testWidgets(
      'renders without overflow with long name and ID on narrow screen',
      (tester) async {
        final longReply = ReplyItem(
          text: 'テスト本文',
          type: ReplyType.user,
          name: 'ものすごく長くて画面幅を超えてしまうような非常に長いユーザー名',
          id: 'very-long-id-1234567890-abcdef',
          origin: ReplyOrigin.user,
        );

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 250, // 狭い画面幅
                child: ReplyCard(
                  number: 9999,
                  reply: longReply,
                  onReply: () {},
                ),
              ),
            ),
          ),
        );

        expect(tester.takeException(), isNull);
        expect(find.byType(ReplyCard), findsOneWidget);
      },
    );
  });
}

ReplyItem _reply({
  required ReplyOrigin origin,
  int? replyTo,
  String text = '本文',
}) {
  return ReplyItem(
    text: text,
    type: origin == ReplyOrigin.user ? ReplyType.user : ReplyType.ai,
    name: origin == ReplyOrigin.user ? '自分' : '名無しのAIさん',
    id: 'test-id',
    replyTo: replyTo,
    origin: origin,
  );
}
