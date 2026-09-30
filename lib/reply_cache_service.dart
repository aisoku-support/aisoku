import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'models/conversation_pattern.dart';
import 'models/ai_reply_report.dart';
import 'models/reply_item.dart';

enum ServerThreadStatus { exists, notFound, unavailable }

class ReplyCacheService {
  static const String _articlesTable = 'articles';
  static const String _chunksTable = 'thread_chunks';

  static SupabaseClient get _client => Supabase.instance.client;

  /// 保存済みローカルスレッドの継続可否を確認する。
  /// 明示的な0件だけを不存在とし、通信・サーバーエラーは確定しない。
  static Future<ServerThreadStatus> checkThreadStatus({
    required String newsUrl,
  }) async {
    try {
      final article = await _client
          .from(_articlesTable)
          .select('id')
          .eq('news_url', newsUrl)
          .maybeSingle();
      if (article == null) return ServerThreadStatus.notFound;

      final chunk = await _client
          .from(_chunksTable)
          .select('chunk_index')
          .eq('article_id', article['id'])
          .limit(1)
          .maybeSingle();
      return chunk == null
          ? ServerThreadStatus.notFound
          : ServerThreadStatus.exists;
    } catch (e) {
      debugPrint('[Cache] thread status unavailable type=${e.runtimeType}');
      return ServerThreadStatus.unavailable;
    }
  }

  /// チャンク単位でレスを保存する
  static Future<void> saveChunk({
    required String newsUrl,
    required String newsTitle,
    required int chunkIndex,
    required List<Map<String, dynamic>> replies,
    required ConversationPattern conversationPattern,
  }) async {
    try {
      final now = DateTime.now().toUtc().toIso8601String();

      // 1. 既存記事は許可済みカラムだけ更新し、なければINSERTする。
      //    merge型UPSERTはnews_urlまでUPDATE対象にするため使用しない。
      final articleMetadata = {
        'news_title': newsTitle,
        'updated_at': now,
        'last_accessed_at': now,
      };
      final updatedArticles = await _client
          .from(_articlesTable)
          .update(articleMetadata)
          .eq('news_url', newsUrl)
          .select('id');

      int? articleId = updatedArticles.isEmpty
          ? null
          : updatedArticles.first['id'];
      if (articleId == null) {
        try {
          final insertedArticles = await _client
              .from(_articlesTable)
              .insert({'news_url': newsUrl, ...articleMetadata})
              .select('id');
          articleId = insertedArticles.isEmpty
              ? null
              : insertedArticles.first['id'];
        } on PostgrestException catch (error) {
          if (error.code != '23505') rethrow;

          // 別クライアントの同時INSERTが先行した場合だけ、作成済み行を取得する。
          final racedArticles = await _client
              .from(_articlesTable)
              .select('id')
              .eq('news_url', newsUrl);
          if (racedArticles.isEmpty) rethrow;
          articleId = racedArticles.first['id'];
        }
      }

      if (articleId == null) {
        debugPrint('[Cache] article_id の取得に失敗しました。');
        return;
      }

      // 共有AI系列の replyTo をチャンク内相対番号 (1-10) に変換
      final int base = (chunkIndex - 1) * 10;
      final processedReplies = replies.map((r) {
        final map = Map<String, dynamic>.from(r);
        if (map['replyTo'] != null) {
          // 絶対 sharedIndex から チャンク内相対番号へ
          map['replyTo'] = (map['replyTo'] as int) - base;
        }
        return map;
      }).toList();

      // 2. チャンクを保存（upsert）
      await _client
          .from(_chunksTable)
          .upsert(
            {
              'article_id': articleId,
              'chunk_index': chunkIndex,
              'replies': processedReplies,
              'conversation_pattern': conversationPattern.name,
              'updated_at': now,
            },
            onConflict: 'article_id,chunk_index',
            ignoreDuplicates: true,
          );

      debugPrint('[Cache] chunk保存成功: article=$articleId, chunk=$chunkIndex');
    } catch (e) {
      debugPrint('[Cache] チャンク保存中にエラーが発生しました: $e');
    }
  }

  /// 特定のチャンクを取得する
  static Future<CachedReplyChunk?> loadChunk({
    required String newsUrl,
    required int chunkIndex,
  }) async {
    final stopwatch = Stopwatch()..start();
    try {
      final article = await _client
          .from(_articlesTable)
          .select('id')
          .eq('news_url', newsUrl)
          .maybeSingle();

      if (article == null) return null;
      final articleId = article['id'];

      final response = await _client
          .from(_chunksTable)
          .select('replies, conversation_pattern')
          .eq('article_id', articleId)
          .eq('chunk_index', chunkIndex)
          .maybeSingle();

      if (response == null) return null;

      final List<dynamic> repliesJson = response['replies'] as List;
      final int base = (chunkIndex - 1) * 10;
      final conversation = _restoreConversation(
        repliesJson: repliesJson,
        storedPattern: response['conversation_pattern']?.toString(),
      );

      // チャンク内相対番号 (1-10) から 絶対 sharedIndex へ復元
      final replies = repliesJson.asMap().entries.map((entry) {
        final map = Map<String, dynamic>.from(entry.value);
        map['reportTargetId'] = AiReplyReport.sharedTargetId(
          newsUrl,
          chunkIndex,
          entry.key + 1,
        );
        if (map['replyTo'] != null) {
          map['replyTo'] = (map['replyTo'] as int) + base;
        }
        return ReplyItem.fromJson(map);
      }).toList();
      debugPrint(
        '[Cache] chunk load completed chunk=$chunkIndex '
        'elapsedMs=${stopwatch.elapsedMilliseconds}',
      );
      return CachedReplyChunk(replies: replies, conversation: conversation);
    } catch (e) {
      debugPrint(
        '[Cache] chunk load failed chunk=$chunkIndex type=${e.runtimeType} '
        'elapsedMs=${stopwatch.elapsedMilliseconds}',
      );
      return null;
    }
  }

  /// 全てのキャッシュ済みレスを取得する
  static Future<Map<String, dynamic>?> loadReplies({
    required String newsUrl,
  }) async {
    try {
      final article = await _client
          .from(_articlesTable)
          .select('id')
          .eq('news_url', newsUrl)
          .maybeSingle();

      if (article == null) return null;
      final articleId = article['id'];

      final List<dynamic> chunks = await _client
          .from(_chunksTable)
          .select('chunk_index, replies, conversation_pattern')
          .eq('article_id', articleId)
          .order('chunk_index', ascending: true);

      if (chunks.isEmpty) return null;

      final List<Map<String, dynamic>> allReplies = [];
      final Map<int, ConversationPlan?> chunkConversations = {};
      for (var chunk in chunks) {
        final replies = chunk['replies'] as List;
        final int chunkIndex = chunk['chunk_index'];
        final int base = (chunkIndex - 1) * 10;
        chunkConversations[chunkIndex] = _restoreConversation(
          repliesJson: replies,
          storedPattern: chunk['conversation_pattern']?.toString(),
        );

        allReplies.addAll(
          replies.asMap().entries.map((entry) {
            final map = Map<String, dynamic>.from(entry.value);
            map['reportTargetId'] = AiReplyReport.sharedTargetId(
              newsUrl,
              chunkIndex,
              entry.key + 1,
            );
            if (map['replyTo'] != null) {
              // 絶対 sharedIndex へ復元
              map['replyTo'] = (map['replyTo'] as int) + base;
            }
            return map;
          }),
        );
      }

      return {
        'replies': allReplies,
        'dbReplyCount': allReplies.length,
        'chunkConversations': chunkConversations,
      };
    } catch (e) {
      debugPrint('[Cache] キャッシュ読み込み中にエラーが発生しました: $e');
      return null;
    }
  }

  static ConversationPlan? _restoreConversation({
    required List<dynamic> repliesJson,
    required String? storedPattern,
  }) {
    final relations = <ReplyRelation>[];
    for (int index = 0; index < repliesJson.length; index++) {
      final map = Map<String, dynamic>.from(repliesJson[index] as Map);
      final replyTo = map['replyTo'];
      if (replyTo is int) {
        relations.add(ReplyRelation(from: index + 1, to: replyTo));
      }
    }
    return ConversationPlan.restore(
      storedPattern: storedPattern,
      count: repliesJson.length,
      relations: relations,
    );
  }

  /// 記事の最終アクセス日時を更新する
  static Future<void> updateLastAccessedAt({required String newsUrl}) async {
    try {
      await _client
          .from(_articlesTable)
          .update({
            'last_accessed_at': DateTime.now().toUtc().toIso8601String(),
          })
          .eq('news_url', newsUrl);
    } catch (e) {
      debugPrint('[Cache] last_accessed_at 更新失敗: $e');
    }
  }
}
