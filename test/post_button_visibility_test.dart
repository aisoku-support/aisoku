import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/pages/news_detail_page.dart';

class MockNewsDetailController extends NewsDetailController {
  MockNewsDetailController()
    : super(
        articleTitle: 'Test Title',
        articleBody: 'Test Body',
        newsUrl: 'https://example.com',
      );

  @override
  Future<void> loadInitialReplies() async {}
}

void main() {
  testWidgets('Post button visibility based on reply box state', (
    WidgetTester tester,
  ) async {
    final controller = MockNewsDetailController();

    const double viewportHeight = 800.0;
    await tester.binding.setSurfaceSize(const Size(400, viewportHeight));

    await tester.pumpWidget(
      MaterialApp(
        home: NewsDetailPage(
          title: 'Test Title',
          url: 'https://example.com',
          controller: controller,
        ),
      ),
    );

    // Initial pump and process post-frame callbacks
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // 1. Initial state (always visible in showHeader: false mode if not read-only)
    expect(find.text('書き込む'), findsOneWidget);

    // 2. Open reply box
    await tester.tap(find.text('書き込む'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('書き込む'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);

    // 3. Close reply box by tapping outside
    // Tap at the top area (outside the bottom input box)
    await tester.tapAt(const Offset(200, 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('書き込む'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('read-only archive hides posting UI and shows ended message', (
    WidgetTester tester,
  ) async {
    final controller = MockNewsDetailController()..isReadOnly = true;

    await tester.pumpWidget(
      MaterialApp(
        home: NewsDetailPage(
          title: 'Test Title',
          url: 'https://example.com',
          controller: controller,
        ),
      ),
    );
    await tester.pump();

    expect(find.text('書き込む'), findsNothing);
    expect(find.byType(TextField), findsNothing);
    expect(find.text('このスレッドは終了しました'), findsOneWidget);
  });

  testWidgets('user delete action requires confirmation and keeps the row', (
    WidgetTester tester,
  ) async {
    final controller = MockNewsDetailController();
    controller.replies.add(
      const ReplyItem(
        text: '削除前',
        type: ReplyType.user,
        name: '自分',
        id: 'user-1',
        origin: ReplyOrigin.user,
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: NewsDetailPage(
          title: 'Test Title',
          url: 'https://example.com',
          controller: controller,
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pumpAndSettle();
    await tester.tap(find.text('削除'));
    await tester.pumpAndSettle();

    expect(find.text('このコメントを削除しますか？'), findsOneWidget);
    expect(find.text('キャンセル'), findsOneWidget);
    await tester.tap(find.text('キャンセル'));
    await tester.pumpAndSettle();
    expect(controller.replies.single.isDeleted, isFalse);

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pumpAndSettle();
    await tester.tap(find.text('削除'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('削除').last);
    await tester.pumpAndSettle();

    expect(controller.replies, hasLength(1));
    expect(controller.replies.single.isDeleted, isTrue);
    expect(find.textContaining('コメントを削除しました'), findsOneWidget);
  });
}
