import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:xml/xml.dart';

import '../models/news_item.dart';
import '../models/rss_feed.dart';

class RssService {
  static const String defaultFeedUrl =
      'https://news.web.nhk/n-data/conf/na/rss/cat0.xml';

  static Future<List<NewsItem>> fetchNews(RssFeed feed) async {
    final response = await http.get(
      Uri.parse(feed.url),
      headers: {'User-Agent': 'Mozilla/5.0'},
    );

    if (response.statusCode != 200) {
      throw Exception('RSS取得失敗: ${response.statusCode}');
    }

    final xmlText = utf8.decode(response.bodyBytes, allowMalformed: true);

    final document = await compute(XmlDocument.parse, xmlText);
    final items = document.findAllElements('item');

    final List<NewsItem> news = [];

    for (final item in items) {
      final title = item.getElement('title')?.innerText.trim() ?? '';

      final link = item.getElement('link')?.innerText.trim() ?? '';

      final pubDateStr = item.getElement('pubDate')?.innerText.trim() ?? '';
      final description =
          item.getElement('description')?.innerText.trim() ?? '';

      if (title.isEmpty || link.isEmpty) {
        continue;
      }

      final publishedAt = _parseRssDate(pubDateStr);

      news.add(
        NewsItem(
          title: title,
          url: link,
          time: pubDateStr.isEmpty ? '最新' : pubDateStr,
          category: feed.name,
          description: description,
          feedUrl: feed.url,
          publishedAt: publishedAt,
        ),
      );
    }

    return news;
  }

  static Future<String?> fetchFeedTitle(String url) async {
    try {
      final response = await http
          .get(Uri.parse(url), headers: {'User-Agent': 'Mozilla/5.0'})
          .timeout(const Duration(seconds: 5));

      if (response.statusCode != 200) return null;

      final xmlText = utf8.decode(response.bodyBytes, allowMalformed: true);

      final document = XmlDocument.parse(xmlText);

      // RSS 2.0: channel > title
      final channelTitle = document
          .findAllElements('channel')
          .firstOrNull
          ?.getElement('title')
          ?.innerText
          .trim();

      if (channelTitle != null && channelTitle.isNotEmpty) {
        return channelTitle;
      }

      // RSS 1.0 / Atom: title
      final title = document
          .findAllElements('title')
          .firstOrNull
          ?.innerText
          .trim();

      return (title != null && title.isNotEmpty) ? title : null;
    } catch (e) {
      debugPrint('RSSタイトル取得失敗: $url, $e');
      return null;
    }
  }

  static DateTime? _parseRssDate(String dateString) {
    if (dateString.isEmpty) return null;

    try {
      // 1. Try standard ISO/RFC 3339
      final isoDate = DateTime.tryParse(dateString);
      if (isoDate != null) return isoDate;

      // 2. Manual parse for RFC 822 (e.g. "Fri, 28 Aug 2026 12:48:46 GMT")
      // Remove day of week if present
      String cleanDate = dateString;
      if (dateString.contains(',')) {
        cleanDate = dateString.split(',').last.trim();
      }

      final parts = cleanDate.split(' ');
      if (parts.length < 4) return null;

      final day = int.tryParse(parts[0]);
      final monthStr = parts[1].toLowerCase();
      final year = int.tryParse(parts[2]);
      final timeParts = parts[3].split(':');

      if (day == null || year == null || timeParts.length < 2) return null;

      final months = {
        'jan': 1,
        'feb': 2,
        'mar': 3,
        'apr': 4,
        'may': 5,
        'jun': 6,
        'jul': 7,
        'aug': 8,
        'sep': 9,
        'oct': 10,
        'nov': 11,
        'dec': 12,
      };

      final month = months[monthStr];
      if (month == null) return null;

      final hour = int.tryParse(timeParts[0]) ?? 0;
      final minute = int.tryParse(timeParts[1]) ?? 0;
      final second = timeParts.length > 2
          ? (int.tryParse(timeParts[2]) ?? 0)
          : 0;

      // Assume UTC if GMT is present, otherwise local
      final isUtc =
          cleanDate.contains('GMT') ||
          cleanDate.contains('UTC') ||
          cleanDate.endsWith('Z');

      if (isUtc) {
        return DateTime.utc(year, month, day, hour, minute, second);
      } else {
        return DateTime(year, month, day, hour, minute, second);
      }
    } catch (e) {
      debugPrint('RSS日付解析エラー: $dateString, $e');
      return null;
    }
  }
}
