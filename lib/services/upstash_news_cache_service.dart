import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:http/http.dart' as http;

import '../models/news_item.dart';
import '../models/rss_feed.dart';
import 'news_perf.dart';

class UpstashNewsCacheService {
  static String get _restUrl => dotenv.env['UPSTASH_REDIS_REST_URL'] ?? '';
  static String get _readOnlyToken =>
      dotenv.env['UPSTASH_REDIS_REST_READ_ONLY_TOKEN'] ?? '';

  static Future<List<NewsItem>> fetchNews(
    List<RssFeed> localFeeds, {
    bool requireAllFeeds = false,
  }) async {
    if (_restUrl.isEmpty || _readOnlyToken.isEmpty) {
      debugPrint('[UpstashNews] ERROR: Missing credentials in .env');
      return [];
    }

    if (localFeeds.isEmpty) return [];

    NewsPerf.mark('UPSTASH_REQUEST');

    try {
      // 1. 各フィードのキーを生成
      final keys = localFeeds.map((f) => 'news:feed:${f.url}').toList();

      // 2. MGET リクエストの構築 (REST POST方式)
      final response = await http.post(
        Uri.parse(_restUrl),
        headers: {
          'Authorization': 'Bearer $_readOnlyToken',
          'Content-Type': 'application/json',
        },
        body: jsonEncode(['MGET', ...keys]),
      );

      if (response.statusCode != 200) {
        throw Exception('Upstash API Error: ${response.statusCode}');
      }

      final Map<String, dynamic> body = jsonDecode(response.body);
      final List<dynamic>? results = body['result'] as List<dynamic>?;

      if (results == null) {
        return [];
      }

      final int expectedCount = keys.length;
      final int actualCount = results.where((r) => r != null).length;

      if (requireAllFeeds && actualCount < expectedCount) {
        debugPrint(
          '[News] Upstash incomplete feeds=$actualCount/$expectedCount, fallback to RSS',
        );
        return [];
      }

      final List<NewsItem> allNews = [];

      for (int i = 0; i < results.length; i++) {
        final resultStr = results[i];
        if (resultStr == null) continue;

        final feed = localFeeds[i];
        final List<dynamic> feedNewsJson = jsonDecode(resultStr.toString());
        for (var json in feedNewsJson) {
          allNews.add(
            NewsItem(
              title: json['title'] ?? '',
              url: json['url'] ?? '',
              time: json['time'] ?? '',
              category: feed.name,
              description: json['description'] ?? '',
              feedUrl: feed.url,
              publishedAt: json['published_at'] != null
                  ? DateTime.parse(json['published_at'])
                  : null,
            ),
          );
        }
      }

      // 重複除去とソート
      final seenUrls = <String>{};
      final uniqueNews = allNews.where((n) => seenUrls.add(n.url)).toList();

      uniqueNews.sort((a, b) {
        if (a.publishedAt == null && b.publishedAt == null) return 0;
        if (a.publishedAt == null) return 1;
        if (b.publishedAt == null) return -1;
        return b.publishedAt!.compareTo(a.publishedAt!);
      });

      NewsPerf.mark(
        'UPSTASH_RESPONSE',
        extra: 'items=${uniqueNews.length} feeds=$actualCount/$expectedCount',
      );

      return uniqueNews;
    } catch (e) {
      debugPrint('[UpstashNews] ERROR: $e');
      rethrow;
    }
  }
}
