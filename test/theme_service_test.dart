import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:news_app/services/theme_service.dart';
import 'package:news_app/pages/settings_page.dart';
import 'package:news_app/pages/news_home_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ThemeService Tests', () {
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      // ThemeServiceを初期状態リセット
      await ThemeService.instance.setThemeMode(ThemeMode.system);
    });

    test('初期表示でSharedPreferencesに未保存の場合、ThemeMode.systemが返されること', () async {
      SharedPreferences.setMockInitialValues({});
      await ThemeService.instance.init();
      expect(ThemeService.instance.themeMode, ThemeMode.system);
    });

    test('ThemeModeを変更するとSharedPreferencesに永続化されること', () async {
      SharedPreferences.setMockInitialValues({});

      await ThemeService.instance.setThemeMode(ThemeMode.dark);
      expect(ThemeService.instance.themeMode, ThemeMode.dark);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'dark');

      await ThemeService.instance.setThemeMode(ThemeMode.light);
      expect(ThemeService.instance.themeMode, ThemeMode.light);
      expect(prefs.getString('theme_mode'), 'light');

      await ThemeService.instance.setThemeMode(ThemeMode.system);
      expect(ThemeService.instance.themeMode, ThemeMode.system);
      expect(prefs.getString('theme_mode'), null);
    });
  });

  group('SettingsPage Theme Settings UI Test', () {
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await ThemeService.instance.init();
      await ThemeService.instance.setThemeMode(ThemeMode.system);
    });

    testWidgets('設定画面で「外観」を選択してテーマダイアログで切り替えられること', (
      WidgetTester tester,
    ) async {
      final controller = NewsHomeController();

      await tester.pumpWidget(
        MaterialApp(
          home: SettingsPage(
            controller: controller,
            onNewsTap: (_) {},
            onNewsLongPress: (_) {},
            onAddFeed: () async {},
            onDeleteFeed: (_) async {},
          ),
        ),
      );

      // 「外観」タイルが存在し、現在の設定「端末の設定に従う」が表示されていること
      expect(find.text('外観'), findsOneWidget);
      expect(find.text('端末の設定に従う'), findsOneWidget);

      // 外観設定をタップ
      await tester.tap(find.text('外観'));
      await tester.pumpAndSettle();

      // ダイアログが開くこと
      expect(find.text('ダーク'), findsOneWidget);
      expect(find.text('ライト'), findsOneWidget);

      // 「ダーク」を選択
      await tester.tap(find.text('ダーク'));
      await tester.pumpAndSettle();

      // ThemeServiceのモードがダークに変更されていること
      expect(ThemeService.instance.themeMode, ThemeMode.dark);
      // サブタイトルが「ダーク」に更新されていること
      expect(find.text('ダーク'), findsOneWidget);
    });
  });
}
