import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/news_item.dart';
import '../models/rss_feed.dart';

class NewsCacheService {
  static Future<void>? _initFuture;
  static bool _hasTouchedRssFeedsThisSession = false;

  /// Supabase初期化Futureを設定する
  static void setInitFuture(Future<void> future) {
    _initFuture = future;
  }

  /// Supabaseクライアントを取得する。初期化完了を待機する。
  static Future<SupabaseClient> get _client async {
    if (_initFuture != null) {
      await _initFuture;
    }
    return Supabase.instance.client;
  }

  /// ローカルキャッシュ（SharedPreferences）にニュースを保存する
  static Future<void> saveLocalCache(List<NewsItem> items) async {
    try {
      final List<String> jsonList = items
          .map(
            (item) => jsonEncode({
              'title': item.title,
              'url': item.url,
              'time': item.time,
              'category': item.category,
              'feedUrl': item.feedUrl,
              'publishedAt': item.publishedAt?.toIso8601String(),
            }),
          )
          .toList();

      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList('local_news_cache', jsonList);
    } catch (e) {
      debugPrint('[Cache] ローカルキャッシュ保存失敗: $e');
    }
  }

  /// ローカルキャッシュからニュースを読み込み、現在の有効なフィードでフィルタリングする
  static Future<List<NewsItem>> loadLocalCache(List<RssFeed> localFeeds) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final List<String>? jsonList = prefs.getStringList('local_news_cache');
      if (jsonList == null || jsonList.isEmpty) return [];

      final allowedUrls = localFeeds.map((f) => f.url).toSet();

      final List<NewsItem> items = jsonList
          .map((j) {
            final map = jsonDecode(j) as Map<String, dynamic>;
            final pubDateStr = map['publishedAt'] ?? map['published_at'];
            return NewsItem(
              title: map['title'] ?? '',
              url: map['url'] ?? '',
              time: map['time'] ?? '',
              category: map['category'] ?? '',
              feedUrl: map['feedUrl'] ?? '',
              publishedAt: pubDateStr != null
                  ? DateTime.parse(pubDateStr)
                  : null,
            );
          })
          .where((item) => allowedUrls.contains(item.feedUrl))
          .toList();

      return items;
    } catch (e) {
      debugPrint('[Cache] ローカルキャッシュ読込失敗: $e');
      return [];
    }
  }

  /// ユーザーが新しいRSSを追加した際、共有マスター（Upstash）へ登録する
  static Future<void> ensureRssFeedExists(
    String url,
    String? sourceName,
  ) async {
    try {
      final client = await _client;

      // エッジ関数 'ensure-rss-feed' を呼び出し、Upstash RSSマスターへ登録する
      final response = await client.functions.invoke(
        'ensure-rss-feed',
        body: {'url': url, 'source_name': sourceName, 'mark_active': true},
      );

      if (response.status != 200) {
        throw Exception('RSS登録失敗: ${response.status} ${response.data}');
      }

      debugPrint('[Cache] RSS同期成功: $url');
    } catch (e) {
      debugPrint('[Cache] RSS同期失敗: url=$url, error=$e');
      rethrow;
    }
  }

  /// このセッションで利用中のユーザーRSSを巡回対象として更新する。
  static Future<void> touchRssFeeds(Iterable<String> urls) async {
    final uniqueUrls = urls
        .map((url) => url.trim())
        .where((url) {
          return url.isNotEmpty;
        })
        .toSet()
        .toList();
    if (uniqueUrls.isEmpty || _hasTouchedRssFeedsThisSession) return;
    _hasTouchedRssFeedsThisSession = true;

    try {
      final client = await _client;
      final response = await client.functions.invoke(
        'touch-rss-feeds',
        body: {'urls': uniqueUrls},
      );
      if (response.status != 200) {
        throw Exception('RSS利用状態更新失敗: ${response.status} ${response.data}');
      }
      debugPrint('[Cache] RSS利用状態更新成功: ${uniqueUrls.length} feeds');
    } catch (e) {
      debugPrint('[Cache] RSS利用状態更新失敗: $e');
    }
  }
}
