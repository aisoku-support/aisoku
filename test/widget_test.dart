import 'package:flutter_test/flutter_test.dart';

import 'package:news_app/main.dart';

void main() {
  testWidgets('ニュースアプリ起動テスト', (WidgetTester tester) async {
    await tester.pumpWidget(const NewsApp());

    expect(find.text('AIニュース掲示板'), findsOneWidget);
  });
}
