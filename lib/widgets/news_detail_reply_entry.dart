import 'package:flutter/material.dart';

import '../models/reply_item.dart';
import 'pr_card.dart';
import 'reply_card.dart';

/// 1つのレスに関連する表示（レスカード、付随する広告、生成中メッセージ）を組み立てるWidget。
/// 見た目や配置順序の責務を負う。
class NewsDetailReplyEntry extends StatelessWidget {
  final ReplyItem reply;
  final int number;
  final AdPlacement? adPlacement;
  final String? generatingMessage;
  final VoidCallback onReply;
  final ValueChanged<int> onAnchorTap;
  final GlobalKey? replyKey;
  final VoidCallback? onReport;
  final VoidCallback? onDelete;
  final bool isReported;
  final Widget? adWidget;
  final ValueChanged<BuildContext>? onMorePressed;

  const NewsDetailReplyEntry({
    super.key,
    this.replyKey,
    required this.reply,
    required this.number,
    this.adPlacement,
    this.generatingMessage,
    required this.onReply,
    required this.onAnchorTap,
    this.onReport,
    this.onDelete,
    this.isReported = false,
    this.adWidget,
    this.onMorePressed,
  });

  @override
  Widget build(BuildContext context) {
    final widgets = <Widget>[
      ReplyCard(
        key: replyKey,
        number: number,
        reply: reply,
        onReply: onReply,
        onAnchorTap: onAnchorTap,
        onReport: onReport,
        onDelete: onDelete,
        isReported: isReported,
        onMorePressed: onMorePressed,
      ),
    ];

    if (adPlacement != null) {
      if (adWidget != null) {
        widgets.add(
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 12),
            child: SelectionContainer.disabled(child: adWidget!),
          ),
        );
      }

      // 投稿直後枠の場合、AI返信生成中インジケータを広告の下に表示
      if (adPlacement == AdPlacement.postContribution &&
          generatingMessage != null) {
        widgets.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 16, left: 12),
            child: Row(
              children: [
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    generatingMessage!,
                    style: const TextStyle(color: Colors.grey, fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        );
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: widgets,
    );
  }
}
