import 'dart:convert';
import 'dart:math';

import 'reply_item.dart';

enum AiReplyReportType {
  dislikeOrDisplayIssue('dislike_or_display_issue', '気に入らない・表示がおかしい'),
  harmfulOrAbusive('harmful_or_abusive', '攻撃的・危険な内容'),
  incorrectContent('incorrect_content', '誤った内容'),
  other('other', 'その他');

  const AiReplyReportType(this.value, this.label);
  final String value;
  final String label;
}

class AiReplyReport {
  AiReplyReport({
    required ReplyItem reply,
    required this.newsUrl,
    required this.type,
    String? note,
  }) : targetId = reply.reportTargetId ?? '',
       replyText = reply.text,
       note = type == AiReplyReportType.other ? note : null {
    if (!reply.canReport || targetId.isEmpty) {
      throw ArgumentError('Reply is not reportable');
    }
    if ((this.note?.runes.length ?? 0) > 200) {
      throw ArgumentError('Note exceeds 200 characters');
    }
  }

  final String targetId;
  final String newsUrl;
  final String replyText;
  final AiReplyReportType type;
  final String? note;

  Map<String, dynamic> toJson() => {
    'report_target_id': targetId,
    'news_url': newsUrl,
    'reply_text': replyText,
    'report_type': type.value,
    'note': note,
  };

  static String sharedTargetId(String newsUrl, int chunkIndex, int position) =>
      'shared:${jsonEncode([newsUrl, chunkIndex, position])}';

  static String localTargetId() {
    final random = Random.secure();
    return 'local:${List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
  }
}
