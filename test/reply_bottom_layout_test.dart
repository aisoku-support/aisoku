import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/widgets/news_detail_reply_bottom.dart';

void main() {
  group('NewsDetailReplyBottom', () {
    testWidgets('1. 生成失敗時に既存の失敗表示・再試行ボタンが表示される', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyBottom(
              isGenerating: false,
              isLoading: false,
              loadMoreErrorMessage: 'エラー発生',
              onRetry: () {},
            ),
          ),
        ),
      );

      expect(find.text('エラー発生'), findsOneWidget);
      expect(find.text('住民を呼び戻す'), findsOneWidget);
    });

    testWidgets('2. 生成中インジケータが表示される', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyBottom(
              isGenerating: true,
              isLoading: false,
              sharedLoadingMessage: '生成中...',
              onRetry: () {},
            ),
          ),
        ),
      );

      expect(find.text('生成中...'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('3. 何も表示されない状態（通常時）', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewsDetailReplyBottom(
              isGenerating: false,
              isLoading: false,
              onRetry: () {},
            ),
          ),
        ),
      );

      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('住民を呼び戻す'), findsNothing);
    });
  });
}
