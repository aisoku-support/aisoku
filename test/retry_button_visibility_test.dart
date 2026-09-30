import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/widgets/news_detail_reply_sheet.dart';

class MockNewsDetailController extends NewsDetailController {
  MockNewsDetailController({String? errorMessage})
    : _mockErrorMessage = errorMessage,
      super(
        articleTitle: 'Test Article',
        articleBody: 'Test Body',
        newsUrl: 'https://example.com',
      );

  final String? _mockErrorMessage;

  @override
  String? get loadMoreErrorMessage => _mockErrorMessage;

  @override
  Future<void> loadInitialReplies() async {}
  @override
  Future<void> loadMoreReplies() async {}
}

void main() {
  testWidgets('Retry button is above a simulated "Post" button footprint', (
    WidgetTester tester,
  ) async {
    // 1. Setup controller with an error message
    final controller = MockNewsDetailController(
      errorMessage: 'AIレスの生成に失敗しました。',
    );

    // 2. Prepare some replies
    for (int i = 0; i < 5; i++) {
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

    // 3. Define reserved height (mimic NewsDetailPage calculation)
    // Fixed button height (52) + bottomPositioned (14) + spacing (12) + SafeArea (0 in test)
    const double reservedHeight = 14 + 52 + 12;

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
                reservedBottomHeight: reservedHeight,
                availableHeight: 600,
              ),
            ],
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    // 4. Scroll to the very bottom
    final scrollable = find.byType(Scrollable);
    await tester.drag(scrollable, const Offset(0, -1000));
    await tester.pumpAndSettle();

    // Wait for correction animation (if any triggered)
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();

    // 5. Verify Retry button is visible and above the reserved area
    final retryButton = find.text('住民を呼び戻す');
    expect(retryButton, findsOneWidget);

    final retryRect = tester.getRect(retryButton);

    // The sheet bottom is at y=600 (availableHeight)
    // The reserved area starts at 600 - reservedHeight = 522
    expect(retryRect.bottom, lessThanOrEqualTo(600 - reservedHeight));

    // 6. Verify clickability
    await tester.tap(retryButton);
    await tester.pump();
  });

  testWidgets(
    'Padding shrinks when reservedBottomHeight is small (button hidden)',
    (WidgetTester tester) async {
      final controller = MockNewsDetailController();
      const double smallReservedHeight = 16.0;

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
                  reservedBottomHeight: smallReservedHeight,
                  availableHeight: 600,
                ),
              ],
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      final lastPadding = find.byType(SizedBox).last;
      final box = tester.widget<SizedBox>(lastPadding);
      expect(box.height, smallReservedHeight);
    },
  );
}
