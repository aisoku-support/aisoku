import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/pages/news_home_page.dart';
import 'package:news_app/widgets/scrollable_category_tabs.dart';
import 'package:news_app/services/monetization_analytics_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    dotenv.loadFromString(
      envString: 'UPSTASH_REDIS_REST_URL=http://localhost\nUPSTASH_REDIS_REST_READ_ONLY_TOKEN=test',
    );
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('NewsHomePage category navigation sync (PageView and Tabs)', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: NewsHomePage()));

    // 初期化待ち
    await tester.pump(const Duration(seconds: 1));

    final tabsFinder = find.byType(ScrollableCategoryTabs);
    final pageViewFinder = find.byType(PageView);
    expect(tabsFinder, findsOneWidget);
    expect(pageViewFinder, findsOneWidget);

    // 1. 初期状態確認
    var tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, 0);
    expect(tabsWidget.categories[0], 'トレンド');

    // 2. 左フリック（次へ）
    await tester.fling(pageViewFinder, const Offset(-400, 0), 1000);
    await tester.pump(const Duration(milliseconds: 500));

    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, 1);
    expect(tabsWidget.categories[1], 'エンタメ');

    // 3. 右フリック（前へ）
    await tester.fling(pageViewFinder, const Offset(400, 0), 1000);
    await tester.pump(const Duration(milliseconds: 500));

    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, 0);

    // 4. 小さいドラッグ（戻る）
    await tester.drag(pageViewFinder, const Offset(-50, 0));
    await tester.pump(const Duration(milliseconds: 500));
    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, 0);

    // 5. タブタップで PageView 連動
    await tester.tap(find.text('サブカル'));
    await tester.pump(); // Build trigger
    await tester.pump(const Duration(milliseconds: 500));

    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, 2);

    final pageView = tester.widget<PageView>(pageViewFinder);
    expect(pageView.controller?.page?.round(), 2);

    // 6. 境界ガード（最初で右）
    await tester.tap(find.text('トレンド'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.fling(pageViewFinder, const Offset(400, 0), 1000);
    await tester.pump(const Duration(milliseconds: 500));
    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, 0);

    // 7. 境界ガード（最後で左）
    final lastIndex = tabsWidget.categories.length - 1;
    await tester.tap(find.text(tabsWidget.categories[lastIndex]));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.fling(pageViewFinder, const Offset(-400, 0), 1000);
    await tester.pump(const Duration(milliseconds: 500));
    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, lastIndex);

    // 8. 縦スクロールで切り替わらない
    await tester.fling(pageViewFinder, const Offset(0, -400), 1000);
    await tester.pump(const Duration(milliseconds: 500));
    tabsWidget = tester.widget<ScrollableCategoryTabs>(tabsFinder);
    expect(tabsWidget.selectedIndex, lastIndex);

    // テスト終了時のタイマー待ち回避
    MonetizationAnalyticsService.instance.dispose();
    await tester.pumpWidget(Container());
    await tester.pump(const Duration(seconds: 1));
  });
}
