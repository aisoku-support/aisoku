import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:news_app/pages/news_home_controller.dart';
import 'package:news_app/models/news_item.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('NewsHomeController RPC Pagination Tests', () {
    test('loadMoreCurrentCategory triggers RPC when display size equals available items', () async {
      final mockResponse = [
        {
          'topic_id': 'topic-51',
          'category': 'トレンド',
          'title': '追加の運営ニュース',
          'url': 'https://example.com/51',
          'published_at': '2026-09-15T00:00:00Z',
          'created_at': '2026-09-15T00:00:00Z',
        },
      ];

      final controller = NewsHomeController(
        fetchNewsData: () async => List.generate(
          50,
          (index) => NewsItem(
            title: '初期ニュース $index',
            url: 'https://example.com/$index',
            time: '',
            category: 'ソース',
            feedUrl: '',
            articleId: 'topic-$index',
            appCategories: ['トレンド'],
            publishedAt: DateTime.parse('2026-09-14T00:00:00Z'),
            createdAt: DateTime.parse('2026-09-14T00:00:00Z'),
          ),
        ),
        rpcFetchPage: (category, cursorCreatedAt, cursorTopicId) async {
          return mockResponse;
        },
      );

      await controller.initialize();

      // 最初は50件表示
      expect(controller.newsList.length, 50);

      // loadMoreCurrentCategory を呼ぶと末尾に到達しているため RPC（mock）が走る
      controller.loadMoreCurrentCategory();

      await Future.delayed(const Duration(milliseconds: 100));

      // 取得したニュースが1件追加されていること（50 + 1 = 51）
      expect(controller.newsList.length, 51);
      expect(controller.newsList.any((n) => n.title == '追加の運営ニュース'), isTrue);
    });
  });
}
