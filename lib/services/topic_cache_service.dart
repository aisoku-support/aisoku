import 'dart:convert';

import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/news_item.dart';

/// 生成済みTopic一覧キャッシュの読取専用経路。
class TopicCacheService {
  static const _cacheKey = 'news:topics';
  static const _localKey = 'local_topic_list_cache';

  static NewsItem parseTopic(Map<String, dynamic> map) {
    final createdAtStr = map['created_at'] as String?;
    final firstSeenAtStr = map['first_seen_at'] as String?;
    return NewsItem(
      title: map['title'] as String,
      url: map['url'] as String,
      time: '',
      category: map['source_name'] as String? ?? '',
      description: map['description'] as String? ?? '',
      feedUrl: '',
      // articleId は既存の運営ニュース判定に使うため、Topic IDを設定する。
      articleId: map['topic_id'] as String,
      appCategories: [map['category'] as String],
      publishedAt: DateTime.parse(map['published_at'] as String),
      createdAt: createdAtStr != null ? DateTime.parse(createdAtStr) : null,
      firstSeenAt: firstSeenAtStr != null
          ? DateTime.parse(firstSeenAtStr)
          : null,
      threadTitle: map['thread_title'] as String?,
      representativeTitle: map['representative_title'] as String?,
      topicSubject: map['subject'] as String?,
      topicEvent: map['event'] as String?,
      topicFacts: (map['facts'] as List? ?? const [])
          .whereType<String>()
          .toList(),
      topicCreationMode: map['creation_mode'] as String?,
    );
  }

  static Future<List<NewsItem>> fetchNews({http.Client? client}) async {
    final transport = client ?? http.Client();
    try {
      final url = dotenv.env['UPSTASH_REDIS_REST_URL'] ?? '';
      final token = dotenv.env['UPSTASH_REDIS_REST_READ_ONLY_TOKEN'] ?? '';
      if (url.isEmpty || token.isEmpty) {
        throw StateError('Topic cache configuration missing');
      }
      final response = await transport
          .post(
            Uri.parse(url),
            headers: {
              'Authorization': 'Bearer $token',
              'Content-Type': 'application/json',
            },
            body: jsonEncode(['GET', _cacheKey]),
          )
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) {
        throw StateError('Topic cache HTTP failure');
      }
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      if (body['error'] != null || body['result'] == null) {
        throw StateError('Topic cache command failure');
      }
      final cache =
          jsonDecode(body['result'] as String) as Map<String, dynamic>;
      final topics = List<Map<String, dynamic>>.from(
        (cache['topics'] as List).map(
          (item) => Map<String, dynamic>.from(item as Map),
        ),
      );
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_localKey, jsonEncode(topics));
      return topics.map(parseTopic).toList();
    } finally {
      if (client == null) transport.close();
    }
  }

  static Future<List<NewsItem>> loadLocal() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_localKey);
      if (raw == null) return [];
      return (jsonDecode(raw) as List)
          .map((item) => parseTopic(Map<String, dynamic>.from(item as Map)))
          .toList();
    } catch (_) {
      return [];
    }
  }
}
