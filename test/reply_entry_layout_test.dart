import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/widgets/news_detail_reply_entry.dart';
import 'package:news_app/widgets/pr_card.dart';
import 'package:news_app/widgets/reply_card.dart';

void main() {
  group('NewsDetailReplyEntry', () {
    final testReply = ReplyItem(
      text: 'Test Reply',
      type: ReplyType.ai,
      name: 'AI Inhabitant',
      id: 'id123',
    );

    testWidgets('1. 通常ReplyCardが表示される', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyEntry(
              reply: testReply,
              number: 1,
              onReply: () {},
              onAnchorTap: (_) {},
            ),
          ),
        ),
      );

      expect(find.byType(ReplyCard), findsOneWidget);
      expect(find.text('Test Reply'), findsOneWidget);
      expect(find.text('1'), findsOneWidget);
    });

    testWidgets('2. 通常広告枠にadWidgetが表示される', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyEntry(
              reply: testReply,
              number: 1,
              adPlacement: AdPlacement.normalComment,
              adWidget: const SizedBox(key: Key('test-ad'), height: 50),
              onReply: () {},
              onAnchorTap: (_) {},
            ),
          ),
        ),
      );

      expect(find.byKey(const Key('test-ad')), findsOneWidget);
      expect(
        tester.getTopLeft(find.byKey(const Key('test-ad'))).dy,
        greaterThan(tester.getBottomLeft(find.byType(ReplyCard)).dy),
      );
    });

    testWidgets('3. 投稿直後広告枠にadWidgetが表示される', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyEntry(
              reply: testReply,
              number: 1,
              adPlacement: AdPlacement.postContribution,
              adWidget: const SizedBox(key: Key('test-ad'), height: 50),
              onReply: () {},
              onAnchorTap: (_) {},
            ),
          ),
        ),
      );

      expect(find.byKey(const Key('test-ad')), findsOneWidget);
    });

    testWidgets('4. localAi生成中表示が広告の下に表示される', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyEntry(
              reply: testReply,
              number: 1,
              adPlacement: AdPlacement.postContribution,
              adWidget: const SizedBox(key: Key('test-ad'), height: 50),
              generatingMessage: '生成中...',
              onReply: () {},
              onAnchorTap: (_) {},
            ),
          ),
        ),
      );

      final adTop = tester.getTopLeft(find.byKey(const Key('test-ad'))).dy;
      final generatingTop = tester.getTopLeft(find.text('生成中...')).dy;
      expect(find.text('生成中...'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(
        adTop,
        greaterThan(tester.getBottomLeft(find.byType(ReplyCard)).dy),
      );
      expect(generatingTop, greaterThan(adTop));
    });

    testWidgets('5. GlobalKeyが正しくReplyCardへ転送される', (WidgetTester tester) async {
      final globalKey = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyEntry(
              replyKey: globalKey,
              reply: testReply,
              number: 1,
              onReply: () {},
              onAnchorTap: (_) {},
            ),
          ),
        ),
      );

      final replyCardFinder = find.byType(ReplyCard);
      expect(tester.widget(replyCardFinder).key, equals(globalKey));
    });

    testWidgets('6. 狭い画面幅でもgeneratingMessageがoverflowしない', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 200,
              child: NewsDetailReplyEntry(
                reply: testReply,
                number: 1,
                adPlacement: AdPlacement.postContribution,
                generatingMessage: 'AI住人が非常に長いレスを生成している最中です...',
                onReply: () {},
                onAnchorTap: (_) {},
              ),
            ),
          ),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('AI住人が非常に長いレスを生成している最中です...'), findsOneWidget);
    });
  });
}
