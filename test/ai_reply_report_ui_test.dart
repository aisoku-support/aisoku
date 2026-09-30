import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/ai_reply_report.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/widgets/ai_reply_report_sheet.dart';
import 'package:news_app/widgets/reply_card.dart';

void main() {
  testWidgets('AI and user menus preserve reply and copy actions', (
    tester,
  ) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = call.arguments['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    for (final origin in ReplyOrigin.values) {
      var replies = 0;
      var reports = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReplyCard(
              number: 2,
              reply: ReplyItem(
                text: '本文',
                type: origin == ReplyOrigin.user
                    ? ReplyType.user
                    : ReplyType.ai,
                name: 'name',
                id: 'id',
                origin: origin,
              ),
              onReply: () => replies++,
              onReport: () => reports++,
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('レス操作'));
      await tester.pumpAndSettle();
      expect(find.text('返信'), findsOneWidget);
      expect(find.text('コピー'), findsOneWidget);
      expect(
        find.text('通報'),
        origin == ReplyOrigin.user ? findsNothing : findsOneWidget,
      );
      await tester.tap(find.text('返信'));
      await tester.pumpAndSettle();
      expect(replies, 1);
      await tester.tap(find.byTooltip('レス操作'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('コピー'));
      await tester.pumpAndSettle();
      expect(copied, '本文');
      if (origin != ReplyOrigin.user) {
        await tester.tap(find.byTooltip('レス操作'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('通報'));
        await tester.pumpAndSettle();
        expect(reports, 1);
      }
    }
  });

  testWidgets('reported body retains header, anchor and report action', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ReplyCard(
            number: 5,
            reply: const ReplyItem(
              text: '元本文',
              type: ReplyType.ai,
              name: 'AI',
              id: 'resident',
              replyTo: 2,
            ),
            isReported: true,
            onReply: () {},
            onReport: () {},
          ),
        ),
      ),
    );
    expect(find.text('元本文'), findsNothing);
    expect(find.text('コメントを通報しました'), findsOneWidget);
    expect(find.text('5'), findsOneWidget);
    expect(find.text('ID: resident'), findsOneWidget);
    expect(find.text('>>2'), findsNothing); // 通報済みはアンカーを表示しない
    await tester.tap(find.byTooltip('レス操作'));
    await tester.pumpAndSettle();
    expect(find.text('通報'), findsOneWidget);
  });

  testWidgets('reason order, optional note and failure retry', (tester) async {
    final notes = <String?>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AiReplyReportSheet(
            onSubmit: (type, note) async {
              notes.add(note);
              return false;
            },
          ),
        ),
      ),
    );
    final positions = AiReplyReportType.values
        .map((t) => tester.getTopLeft(find.text(t.label)).dy)
        .toList();
    expect(positions, orderedEquals([...positions]..sort()));
    expect(find.byType(TextField), findsNothing);
    await tester.tap(find.text('その他'));
    await tester.pump();
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.decoration!.hintText, '任意');
    expect(field.decoration!.hintStyle!.color, Colors.grey);
    // 独自のFormatterを使用するため標準のmaxLengthはnull
    expect(field.maxLength, null);
    expect(field.maxLines, greaterThan(1));
    await tester.tap(find.text('送信'));
    await tester.pumpAndSettle();
    expect(notes, ['']);
    expect(find.text('通報できませんでした。もう一度お試しください。'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '古い補足');
    await tester.tap(find.text('誤った内容'));
    await tester.pump();
    expect(find.byType(TextField), findsNothing);
    await tester.tap(find.text('送信'));
    await tester.pumpAndSettle();
    expect(notes, ['', null]);
  });
}
