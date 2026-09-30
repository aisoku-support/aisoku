import 'package:flutter/material.dart';

import '../models/news_item.dart';
import '../widgets/news_card.dart';

class NewsHomeSaved extends StatelessWidget {
  final List<NewsItem> newsList;
  final Set<String> savedUrls;
  final Future<void> Function(NewsItem news) onSave;
  final void Function(NewsItem news) onNewsTap;
  final void Function(NewsItem news) onNewsLongPress;

  const NewsHomeSaved({
    super.key,
    required this.newsList,
    required this.savedUrls,
    required this.onSave,
    required this.onNewsTap,
    required this.onNewsLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final savedNews = newsList
        .where((news) => savedUrls.contains(news.url))
        .toList();

    if (savedNews.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.bookmark_border,
                size: 72,
                color: Colors.grey.shade400,
              ),
              const SizedBox(height: 20),
              const Text(
                '保存したニュースはありません',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 10),
              const Text(
                'ホーム画面の🔖ボタンから\n'
                'ニュースを保存できます。',
                style: TextStyle(color: Colors.grey, fontSize: 15),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, top: 12, bottom: 12),
          child: Text(
            '${savedNews.length}件の保存ニュース',
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
          ),
        ),
        ...savedNews.map(
          (news) => NewsCard(
            news: news,
            isSaved: true,
            onSave: () => onSave(news),
            onTap: () => onNewsTap(news),
            onLongPress: () => onNewsLongPress(news),
          ),
        ),
        const SizedBox(height: 80),
      ],
    );
  }
}
