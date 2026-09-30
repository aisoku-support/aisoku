import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:news_app/pages/news_home_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late NewsHomeController controller;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    controller = NewsHomeController(
      fetchNewsData: () async => [],
      fetchRssCache: (feeds) async => [],
    );
  });

  group('NewsHomeController Category Reordering (onReorderItem behavior)', () {
    test('初期状態のカテゴリ順序とRSS末尾固定を確認', () async {
      SharedPreferences.setMockInitialValues({
        'rss_feed_names': ['RSS1'],
        'rss_feed_urls': ['url1'],
      });
      await controller.initialize();

      expect(controller.categories.last, 'RSS');
      expect(controller.categories.sublist(0, 5), [
        'トレンド',
        'エンタメ',
        'サブカル',
        'マネー',
        'IT・ガジェット',
      ]);
    });

    test('左方向へ1つ移動', () async {
      await controller.initialize();
      // 初期: [トレンド, エンタメ, サブカル, マネー, IT・ガジェット]
      // エンタメ(1) を トレンド(0) の位置へ
      controller.reorderCategories(1, 0);

      expect(controller.categories.sublist(0, 2), ['エンタメ', 'トレンド']);
    });

    test('右方向へ1つ移動', () async {
      await controller.initialize();
      // 初期: [トレンド, エンタメ, サブカル, マネー, IT・ガジェット]
      // トレンド(0) を エンタメ(1) の位置へ (onReorderItem仕様: 挿入先インデックス)
      controller.reorderCategories(0, 1);

      expect(controller.categories.sublist(0, 2), ['エンタメ', 'トレンド']);
    });

    test('右方向へ2つ移動', () async {
      await controller.initialize();
      // [トレンド, エンタメ, サブカル, ...] -> [エンタメ, サブカル, トレンド, ...]
      // トレンド(0) を サブカル(2) の位置へ
      controller.reorderCategories(0, 2);

      expect(controller.categories[2], 'トレンド');
    });

    test('先頭 -> 末尾(RSS直前)へ移動', () async {
      SharedPreferences.setMockInitialValues({
        'rss_feed_names': ['RSS1'],
        'rss_feed_urls': ['url1'],
      });
      await controller.initialize();
      final rssIndex = controller.categories.indexOf('RSS');

      // トレンド(0) を RSS(5) の直前位置(4)へ
      controller.reorderCategories(0, rssIndex - 1);

      expect(controller.categories[rssIndex - 1], 'トレンド');
      expect(controller.categories.last, 'RSS');
    });

    test('RSS直前 -> 先頭へ移動', () async {
      SharedPreferences.setMockInitialValues({
        'rss_feed_names': ['RSS1'],
        'rss_feed_urls': ['url1'],
      });
      await controller.initialize();
      final rssIndex = controller.categories.indexOf('RSS');
      final targetCat = controller.categories[rssIndex - 1];

      controller.reorderCategories(rssIndex - 1, 0);

      expect(controller.categories.first, targetCat);
      expect(controller.categories.last, 'RSS');
    });

    test('RSSは並べ替え対象外 (移動不可ガード)', () async {
      SharedPreferences.setMockInitialValues({
        'rss_feed_names': ['RSS1'],
        'rss_feed_urls': ['url1'],
      });
      await controller.initialize();
      final rssIndex = controller.categories.indexOf('RSS');
      final originalOrder = List<String>.from(controller.categories);

      // 1. RSS自身を先頭へ移動しようとする
      controller.reorderCategories(rssIndex, 0);
      expect(controller.categories, originalOrder);

      // 2. 他のカテゴリをRSSの後ろ(rssIndex)へ移動しようとする
      // onReorderItemでは、0をrssIndexへ移動しようとすると RSSの後ろ(本来の位置5)になるためガード対象
      controller.reorderCategories(0, rssIndex);
      expect(controller.categories, originalOrder);
    });

    test('並べ替え後の保存と復元を確認', () async {
      await controller.initialize();
      // [トレンド, エンタメ, ...] -> [エンタメ, トレンド, ...]
      controller.reorderCategories(0, 1);
      final savedOrder = List<String>.from(controller.categories);

      final newController = NewsHomeController(
        fetchNewsData: () async => [],
        fetchRssCache: (feeds) async => [],
      );
      await newController.initialize();

      expect(newController.categories, savedOrder);
    });

    test('選択中カテゴリの維持 (自分を移動)', () async {
      await controller.initialize();
      controller.setCategoryIndex(0); // トレンド
      expect(controller.categories[controller.selectedCategoryIndex], 'トレンド');

      // トレンド(0) を 2番目(1) へ移動
      controller.reorderCategories(0, 1);

      expect(controller.categories[controller.selectedCategoryIndex], 'トレンド');
      expect(controller.selectedCategoryIndex, 1);
    });

    test('選択中カテゴリの維持 (他を移動)', () async {
      await controller.initialize();
      controller.setCategoryIndex(2); // サブカル
      expect(controller.categories[controller.selectedCategoryIndex], 'サブカル');

      // トレンド(0) を マネー(3) の位置へ移動 (onReorderItem仕様: 挿入先は 3)
      controller.reorderCategories(0, 3);

      expect(controller.categories[controller.selectedCategoryIndex], 'サブカル');
      // [トレンド, エンタメ, サブカル, マネー] -> [エンタメ, サブカル, マネー, トレンド]
      // サブカルは 2 -> 1 になる
      expect(controller.selectedCategoryIndex, 1);
    });

    test('カテゴリ削除・追加時の安全な復元', () async {
      SharedPreferences.setMockInitialValues({
        'reordered_news_categories': ['存在しない', 'エンタメ', 'トレンド'],
      });

      await controller.initialize();

      expect(controller.categories.sublist(0, 2), ['エンタメ', 'トレンド']);
      expect(controller.categories.length, 5);
    });
  });
}
