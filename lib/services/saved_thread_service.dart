import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/news_item.dart';
import '../models/reply_item.dart';

class SavedThreadArchive {
  final NewsItem article;
  final List<ReplyItem> replies;
  final int loadedSharedChunkCount;
  final bool isReadOnly;

  const SavedThreadArchive({
    required this.article,
    this.replies = const [],
    this.loadedSharedChunkCount = 0,
    this.isReadOnly = false,
  });

  SavedThreadArchive copyWith({
    NewsItem? article,
    List<ReplyItem>? replies,
    int? loadedSharedChunkCount,
    bool? isReadOnly,
  }) {
    return SavedThreadArchive(
      article: article ?? this.article,
      replies: replies ?? this.replies,
      loadedSharedChunkCount:
          loadedSharedChunkCount ?? this.loadedSharedChunkCount,
      isReadOnly: isReadOnly ?? this.isReadOnly,
    );
  }

  Map<String, dynamic> toJson() => {
    'article': _articleToJson(article),
    'threadReplies': replies.map((reply) {
      final json = reply.toJson();
      if (reply.reportTargetId != null) {
        json['reportTargetId'] = reply.reportTargetId;
      }
      return json;
    }).toList(),
    'loadedSharedChunkCount': loadedSharedChunkCount,
    'isReadOnly': isReadOnly,
  };

  factory SavedThreadArchive.fromJson(Map<String, dynamic> json) {
    final rawReplies = json['threadReplies'];
    return SavedThreadArchive(
      article: _articleFromJson(
        Map<String, dynamic>.from(json['article'] as Map),
      ),
      replies: rawReplies is List
          ? rawReplies
                .whereType<Map>()
                .map(
                  (reply) =>
                      ReplyItem.fromJson(Map<String, dynamic>.from(reply)),
                )
                .toList()
          : const [],
      loadedSharedChunkCount:
          (json['loadedSharedChunkCount'] as num?)?.toInt() ?? 0,
      isReadOnly: json['isReadOnly'] == true,
    );
  }

  static Map<String, dynamic> _articleToJson(NewsItem article) => {
    'title': article.title,
    'description': article.description,
    'url': article.url,
    'source': article.category,
    'time': article.time,
    'feedUrl': article.feedUrl,
    'publishedAt': article.publishedAt?.toIso8601String(),
    'articleId': article.articleId,
    'newsdataCategories': article.newsdataCategories,
    'appCategories': article.appCategories,
    'fetchedAt': article.fetchedAt?.toIso8601String(),
  };

  static NewsItem _articleFromJson(Map<String, dynamic> json) => NewsItem(
    title: json['title']?.toString() ?? '',
    description: json['description']?.toString() ?? '',
    url: json['url']?.toString() ?? '',
    category: json['source']?.toString() ?? '',
    time: json['time']?.toString() ?? '',
    feedUrl: json['feedUrl']?.toString() ?? '',
    publishedAt: DateTime.tryParse(json['publishedAt']?.toString() ?? ''),
    articleId: json['articleId']?.toString(),
    newsdataCategories: _stringList(json['newsdataCategories']),
    appCategories: _stringList(json['appCategories']),
    fetchedAt: DateTime.tryParse(json['fetchedAt']?.toString() ?? ''),
  );

  static List<String> _stringList(dynamic value) =>
      value is List ? value.map((item) => item.toString()).toList() : const [];
}

class SavedThreadService {
  static const String storageKey = 'saved_news_archives_v1';

  static Future<SavedThreadArchive?> load(String newsUrl) async {
    final archives = await _loadAll();
    final value = archives[newsUrl];
    if (value is! Map) return null;
    try {
      return SavedThreadArchive.fromJson(Map<String, dynamic>.from(value));
    } catch (_) {
      return null;
    }
  }

  static Future<List<NewsItem>> loadArticles(Iterable<String> urls) async {
    final archives = await _loadAll();
    final result = <NewsItem>[];
    for (final url in urls) {
      final value = archives[url];
      if (value is! Map) continue;
      try {
        result.add(
          SavedThreadArchive.fromJson(Map<String, dynamic>.from(value)).article,
        );
      } catch (_) {
        // 壊れた1件だけを無視し、他の保存記事は復元する。
      }
    }
    return result;
  }

  static Future<void> saveArticle(NewsItem article) async {
    final existing = await load(article.url);
    await save(
      (existing ?? SavedThreadArchive(article: article)).copyWith(
        article: article,
      ),
    );
  }

  static Future<void> save(SavedThreadArchive archive) async {
    final prefs = await SharedPreferences.getInstance();
    final archives = await _loadAll();
    archives[archive.article.url] = archive.toJson();
    await prefs.setString(storageKey, jsonEncode(archives));
  }

  static Future<void> delete(String newsUrl) async {
    final prefs = await SharedPreferences.getInstance();
    final archives = await _loadAll();
    if (archives.remove(newsUrl) != null) {
      await prefs.setString(storageKey, jsonEncode(archives));
    }
  }

  static Future<Map<String, dynamic>> _loadAll() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(storageKey);
    if (raw == null || raw.isEmpty) return <String, dynamic>{};
    try {
      return Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      return <String, dynamic>{};
    }
  }
}
