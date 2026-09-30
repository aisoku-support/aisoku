import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/widgets/news_detail_reply_sheet.dart';
import 'package:news_app/widgets/reply_card.dart';

// Use a subclass that prevents real loading/generation
class MockNewsDetailController extends NewsDetailController {
  MockNewsDetailController()
    : super(
        articleTitle: 'Test Article',
        articleBody: 'Test Body',
        newsUrl: 'https://example.com',
      );

  @override
  Future<void> loadInitialReplies() async {
    // Do nothing
  }

  @override
  Future<void> loadMoreReplies() async {
    // Do nothing
  }
}

void main() {
  late MockNewsDetailController controller;

  setUp(() {
    controller = MockNewsDetailController();
  });

  tearDown(() {
    controller.dispose();
  });

  testWidgets('Reply button is responsive after scroll correction animation', (
    WidgetTester tester,
  ) async {
    // 1. Prepare replies
    for (int i = 0; i < 20; i++) {
      controller.replies.add(
        ReplyItem(
          text: 'Reply ${i + 1}',
          type: ReplyType.ai,
          name: 'AI',
          id: 'id_$i',
          origin: ReplyOrigin.sharedAi,
        ),
      );
    }

    int? tappedReplyNumber;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              // Rebuild this builder when controller changes
              controller.addListener(() {
                if (context.mounted) setState(() {});
              });
              return SizedBox(
                height: 500,
                child: Stack(
                  children: [
                    NewsDetailReplySheet(
                      controller: controller,
                      sheetSize: 1.0,
                      minSheetSize: 0.1,
                      middleSheetSize: 0.5,
                      maxSheetSize: 1.0,
                      onMoveSheet: (_) {},
                      onToggleSheet: () {},
                      onHeaderDragUpdate: (_) {},
                      onHeaderDragEnd: (_) {},
                      onShowReplyBox: () {},
                      onReply: (number) => tappedReplyNumber = number,
                      reservedBottomHeight: 16.0,
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    // 2. Trigger scroll correction
    final scrollable = find.byType(CustomScrollView);
    final state = tester.state<ScrollableState>(
      find.descendant(of: scrollable, matching: find.byType(Scrollable)),
    );
    final position = state.position;

    // Jump into padding
    position.jumpTo(position.maxScrollExtent);
    await tester.pump();

    // Execute post frame callback to schedule correction.
    await tester.pump();

    // Finish correction animation (400ms)
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    // 3. Verify Reply button responsiveness
    final lastReplyCard = find.byType(ReplyCard).last;
    final replyButton = find.descendant(
      of: lastReplyCard,
      matching: find.byTooltip('レス操作'),
    );

    expect(replyButton, findsOneWidget);

    await tester.tap(replyButton);
    await tester.pumpAndSettle();
    await tester.tap(find.text('返信'));
    await tester.pumpAndSettle();

    expect(tappedReplyNumber, isNotNull);
  });

  testWidgets('Anchor jump and back button are responsive', (
    WidgetTester tester,
  ) async {
    // 1. Prepare replies (including one with an anchor)
    controller.replies.add(
      ReplyItem(
        text: 'Reply 1',
        type: ReplyType.ai,
        name: 'AI',
        id: 'id_1',
        origin: ReplyOrigin.sharedAi,
      ),
    );
    controller.replies.add(
      ReplyItem(
        text: '>>1 Check this',
        type: ReplyType.ai,
        name: 'AI',
        id: 'id_2',
        replyTo: 1,
        origin: ReplyOrigin.sharedAi,
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              controller.addListener(() {
                if (context.mounted) setState(() {});
              });
              return Stack(
                children: [
                  NewsDetailReplySheet(
                    controller: controller,
                    sheetSize: 1.0,
                    minSheetSize: 0.1,
                    middleSheetSize: 0.5,
                    maxSheetSize: 1.0,
                    availableHeight: 600,
                    onMoveSheet: (_) {},
                    onToggleSheet: () {},
                    onHeaderDragUpdate: (_) {},
                    onHeaderDragEnd: (_) {},
                    onShowReplyBox: () {},
                    onReply: (_) {},
                    reservedBottomHeight: 16.0,
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    // 2. Tap anchor (>>1) in the second reply
    final anchor = find.text('>>1');
    expect(anchor, findsOneWidget);
    await tester.tap(anchor);
    await tester.pump(); // Start jump logic

    // Process nudge
    await tester.pump();

    // Animation (300ms)
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    // 3. Verify jump back button appears
    expect(find.text('2へ戻る'), findsOneWidget);

    // 4. Tap back button
    await tester.tap(find.text('2へ戻る'));
    await tester.pump(); // Start jump back
    await tester.pump(); // Nudge
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    // Back button should disappear
    expect(find.text('2へ戻る'), findsNothing);
  });

  testWidgets('programmatic jump is not followed by bottom correction', (
    tester,
  ) async {
    for (int i = 0; i < 30; i++) {
      controller.replies.add(
        ReplyItem(
          text: 'Reply ${i + 1}',
          type: ReplyType.ai,
          name: 'AI',
          id: 'id_$i',
          origin: ReplyOrigin.sharedAi,
        ),
      );
    }

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              NewsDetailReplySheet(
                controller: controller,
                sheetSize: 1.0,
                minSheetSize: 0.1,
                middleSheetSize: 0.5,
                maxSheetSize: 1.0,
                onMoveSheet: (_) {},
                onToggleSheet: () {},
                onHeaderDragUpdate: (_) {},
                onHeaderDragEnd: (_) {},
                onShowReplyBox: () {},
                onReply: (_) {},
                reservedBottomHeight: 16.0,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    controller.requestJump(30, sourceNumber: null);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    final scrollable = find.byType(CustomScrollView);
    final state = tester.state<ScrollableState>(
      find.descendant(of: scrollable, matching: find.byType(Scrollable)),
    );
    final positionAfterJump = state.position.pixels;

    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();

    expect(state.position.pixels, closeTo(positionAfterJump, 0.1));
  });
}
