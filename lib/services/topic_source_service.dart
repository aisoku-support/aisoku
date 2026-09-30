import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/topic_source_article.dart';

class TopicSourceService {
  const TopicSourceService({this.client});
  final SupabaseClient? client;

  Future<List<TopicSourceArticle>> fetch(String topicId) async {
    final response = await (client ?? Supabase.instance.client).functions
        .invoke('get-topic-sources', body: {'topic_id': topicId});
    if (response.status != 200 || response.data is! Map) {
      throw StateError('Topicソースの取得に失敗しました');
    }
    final articles = (response.data as Map)['articles'];
    if (articles is! List) {
      return const [];
    }
    return articles
        .whereType<Map>()
        .map(
          (item) =>
              TopicSourceArticle.fromJson(Map<String, dynamic>.from(item)),
        )
        .where((item) => item.url.isNotEmpty && item.title.isNotEmpty)
        .toList();
  }
}
