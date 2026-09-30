import 'news_item.dart';

class TopicSourceArticle {
  const TopicSourceArticle({
    required this.articleId,
    required this.title,
    required this.url,
    required this.sourceName,
    this.publishedAt,
  });
  final String articleId;
  final String title;
  final String url;
  final String sourceName;
  final DateTime? publishedAt;

  factory TopicSourceArticle.fromJson(Map<String, dynamic> json) {
    final published = json['published_at'] as String?;
    return TopicSourceArticle(
      articleId: json['article_id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      url: json['url'] as String? ?? '',
      sourceName: json['source_name'] as String? ?? '',
      publishedAt: published == null ? null : DateTime.tryParse(published),
    );
  }

  NewsItem toNewsItem() => NewsItem(
    title: title,
    url: url,
    time: '',
    category: sourceName,
    feedUrl: '',
    articleId: articleId,
    publishedAt: publishedAt,
  );
}
