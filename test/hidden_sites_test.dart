import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/news_item.dart';
import 'package:news_app/pages/news_home_controller.dart';
import 'package:news_app/services/hidden_sites_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

NewsItem article(int i, {String? url, String? category, String? feedUrl}) =>
    NewsItem(
      title: 'Article $i',
      url: url ?? 'https://example.com/$i',
      time: '',
      category: category ?? 'Source',
      feedUrl: feedUrl ?? '',
      articleId: feedUrl == null ? '$i' : null,
      appCategories: const ['トレンド'],
      publishedAt: DateTime.utc(2026, 9, 6).subtract(Duration(minutes: i)),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('HiddenSitesService', () {
    test('normalizeHost handles www and case', () {
      expect(
        HiddenSitesService.normalizeHost('https://www.EXAMPLE.com/path'),
        'example.com',
      );
      expect(
        HiddenSitesService.normalizeHost('http://news.example.com'),
        'news.example.com',
      );
      expect(HiddenSitesService.normalizeHost('example.com'), 'example.com');
    });

    test('persistence works', () async {
      await HiddenSitesService.hide('example.com', 'Example');
      expect(await HiddenSitesService.getHiddenHosts(), {'example.com'});
      expect(await HiddenSitesService.getHiddenSiteNames(), {
        'example.com': 'Example',
      });

      await HiddenSitesService.unhide('example.com');
      expect(await HiddenSitesService.getHiddenHosts(), isEmpty);
    });
  });

  group('NewsHomeController Hidden Sites', () {
    testWidgets('filtering applies to managed categories', (tester) async {
      final controller = NewsHomeController(
        fetchNewsData: () async => [
          article(1, url: 'https://site1.com/1'),
          article(2, url: 'https://site2.com/2'),
          article(3, url: 'https://www.site1.com/3'),
        ],
        fetchRssCache: (_) async => [],
      );

      await controller.initialize();
      await tester.pump();
      expect(controller.newsList.length, 3);

      await controller.hideSite(controller.newsList[0]); // site1.com
      expect(controller.newsList.length, 1);
      expect(controller.newsList[0].url, 'https://site2.com/2');

      await controller.undoHideSite('site1.com');
      expect(controller.newsList.length, 3);

      controller.dispose();
    });

    testWidgets('RSS tab is not filtered', (tester) async {
      SharedPreferences.setMockInitialValues({
        'rss_feed_names': ['RSS'],
        'rss_feed_urls': ['https://rss.com/feed'],
        'hidden_site_hosts': ['rss.com'],
      });

      final controller = NewsHomeController(
        fetchNewsData: () async => [],
        fetchRssCache: (_) async => [
          article(1, url: 'https://rss.com/1', feedUrl: 'https://rss.com/feed'),
        ],
      );

      await controller.initialize();
      await controller.loadNews(rssOnly: true);

      final rssIndex = controller.categories.indexOf('RSS');
      expect(rssIndex, greaterThanOrEqualTo(0));
      controller.setCategoryIndex(rssIndex);
      await tester.pump();

      expect(controller.newsList.length, 1);

      controller.dispose();
    });

    testWidgets('Saved news is not filtered via allNews', (tester) async {
      final item = article(1, url: 'https://hidden.com/1');
      SharedPreferences.setMockInitialValues({
        'saved_news_urls': [item.url],
        'hidden_site_hosts': ['hidden.com'],
      });

      final controller = NewsHomeController(
        fetchNewsData: () async => [item],
        fetchRssCache: (_) async => [],
      );

      await controller.initialize();
      await tester.pump();

      // Home tab filtered
      expect(controller.newsList, isEmpty);

      // But allNews (used by Saved) still has it
      expect(controller.allNews.length, 1);
      expect(controller.allNews[0].url, item.url);

      controller.dispose();
    });

    testWidgets('Subdomains are distinct', (tester) async {
      final controller = NewsHomeController(
        fetchNewsData: () async => [
          article(1, url: 'https://example.com/1'),
          article(2, url: 'https://news.example.com/2'),
        ],
        fetchRssCache: (_) async => [],
      );

      await controller.initialize();
      await tester.pump();

      await controller.hideSite(controller.newsList[0]); // example.com
      expect(controller.newsList.length, 1);
      expect(controller.newsList[0].url, 'https://news.example.com/2');

      controller.dispose();
    });

    testWidgets('Undo restores hidden items', (tester) async {
      final controller = NewsHomeController(
        fetchNewsData: () async => [article(1, url: 'https://undo.com/1')],
        fetchRssCache: (_) async => [],
      );

      await controller.initialize();
      await tester.pump();

      await controller.hideSite(controller.newsList[0]);
      expect(controller.newsList, isEmpty);

      await controller.undoHideSite('undo.com');
      expect(controller.newsList.length, 1);

      controller.dispose();
    });

    testWidgets('Restores from SharedPreferences', (tester) async {
      SharedPreferences.setMockInitialValues({
        'hidden_site_hosts': ['stored.com'],
      });

      final controller = NewsHomeController(
        fetchNewsData: () async => [article(1, url: 'https://stored.com/1')],
        fetchRssCache: (_) async => [],
      );

      await controller.initialize();
      await tester.pump();

      expect(controller.newsList, isEmpty);

      controller.dispose();
    });
  });
}
