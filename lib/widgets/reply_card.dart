import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/reply_item.dart';

class ReplyCard extends StatelessWidget {
  final int number;
  final ReplyItem reply;
  final VoidCallback onReply;
  final ValueChanged<int>? onAnchorTap;
  final VoidCallback? onReport;
  final VoidCallback? onDelete;
  final bool isReported;

  final void Function(BuildContext context)? onMorePressed;

  const ReplyCard({
    super.key,
    required this.number,
    required this.reply,
    required this.onReply,
    this.onAnchorTap,
    this.onReport,
    this.onDelete,
    this.isReported = false,
    this.onMorePressed,
  });

  static Future<void> showReplyActions({
    required BuildContext context,
    required int number,
    required ReplyItem reply,
    VoidCallback? onReply,
    VoidCallback? onReport,
    VoidCallback? onDelete,
    bool isReported = false,
  }) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (onReply != null)
              ListTile(
                title: const Text('返信'),
                leading: const Icon(Icons.reply),
                onTap: () => Navigator.pop(context, 'reply'),
              ),
            ListTile(
              title: const Text('コピー'),
              leading: const Icon(Icons.copy),
              onTap: () => Navigator.pop(context, 'copy'),
            ),
            if (reply.canReport && onReport != null)
              ListTile(
                title: const Text('通報'),
                leading: const Icon(Icons.flag_outlined),
                onTap: () => Navigator.pop(context, 'report'),
              ),
            if (reply.origin == ReplyOrigin.user && onDelete != null)
              ListTile(
                title: const Text('削除'),
                leading: const Icon(Icons.delete_outline),
                onTap: () => Navigator.pop(context, 'delete'),
              ),
          ],
        ),
      ),
    );
    if (!context.mounted) return;
    switch (action) {
      case 'reply':
        onReply?.call();
      case 'copy':
        final text = isReported
            ? 'コメントを通報しました'
            : reply.isDeleted
            ? 'コメントを削除しました'
            : reply.text;
        final copyText =
            (isReported || reply.isDeleted || reply.replyTo == null)
            ? text
            : '>>${reply.replyTo}${reply.origin == ReplyOrigin.user ? '' : '\n'}$text';
        await Clipboard.setData(ClipboardData(text: copyText));
      case 'report':
        onReport?.call();
      case 'delete':
        onDelete?.call();
    }
  }

  Future<void> _showActions(BuildContext context) async {
    await showReplyActions(
      context: context,
      number: number,
      reply: reply,
      onReply: onReply,
      onReport: onReport,
      onDelete: onDelete,
      isReported: isReported,
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool isUser = reply.type == ReplyType.user;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final displayText = reply.isDeleted ? 'コメントを削除しました' : reply.text;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: isUser
          ? (isDark ? const Color(0xFF1E293B) : Colors.blue.shade50)
          : Theme.of(context).cardColor,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    // ヘッダーテキスト（番号、名前、ID）を選択対象から外す
                    Expanded(
                      child: SelectionContainer.disabled(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Text(
                              '$number',
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.bold,
                                color: isUser ? Colors.blue : Colors.grey,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                isUser ? reply.name : '名無しのAIさん',
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                  color: isUser
                                      ? Colors.blue
                                      : (isDark
                                            ? Colors.grey.shade400
                                            : Colors.grey.shade700),
                                ),
                                overflow: TextOverflow.ellipsis,
                                maxLines: 1,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                'ID: ${reply.id}',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: Colors.grey.shade500,
                                ),
                                overflow: TextOverflow.ellipsis,
                                maxLines: 1,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 40), // ボタンとの重なり防止
                  ],
                ),
                const SizedBox(height: 2),
                // 本文（>>アンカー含む）のみを選択可能にする
                // 親の NewsDetailReplySheet で SelectionArea を使用するため、ここでは通常の Text
                if (!isReported &&
                    !reply.isDeleted &&
                    reply.replyTo != null &&
                    reply.origin == ReplyOrigin.user)
                  Text.rich(
                    TextSpan(
                      children: [
                        WidgetSpan(
                          alignment: PlaceholderAlignment.baseline,
                          baseline: TextBaseline.alphabetic,
                          child: GestureDetector(
                            onTap: onAnchorTap != null
                                ? () => onAnchorTap!(reply.replyTo!)
                                : null,
                            child: Text(
                              '>>${reply.replyTo}',
                              style: const TextStyle(
                                color: Colors.blue,
                                fontSize: 14,
                                fontWeight: FontWeight.bold,
                                height: 1.3,
                              ),
                            ),
                          ),
                        ),
                        TextSpan(
                          text: displayText,
                          style: const TextStyle(fontSize: 16, height: 1.5),
                        ),
                      ],
                    ),
                  )
                else if (!isReported &&
                    !reply.isDeleted &&
                    reply.replyTo != null)
                  Padding(
                    padding: EdgeInsets.only(
                      bottom: displayText.isNotEmpty ? 2 : 0,
                    ),
                    child: GestureDetector(
                      onTap: onAnchorTap != null
                          ? () => onAnchorTap!(reply.replyTo!)
                          : null,
                      child: Text(
                        '>>${reply.replyTo}',
                        style: const TextStyle(
                          color: Colors.blue,
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ),
                if ((isReported || reply.isDeleted || displayText.isNotEmpty) &&
                    (isReported ||
                        reply.isDeleted ||
                        reply.replyTo == null ||
                        reply.origin != ReplyOrigin.user))
                  Text(
                    isReported ? 'コメントを通報しました' : displayText,
                    style: const TextStyle(fontSize: 16, height: 1.5),
                  ),
              ],
            ),
          ),
          // 操作ボタンをオーバーレイ配置（ヘッダー行の高さ計算から外す）
          Positioned(
            top: 2.5, // (14px padding + ~17px text height / 2) - 40px button height / 2 = 2.5px
            right: 14, // Padding(14) と同じ位置
            child: SelectionContainer.disabled(
              child: IconButton(
                tooltip: 'レス操作',
                onPressed: () {
                  if (onMorePressed != null) {
                    onMorePressed!(context);
                  } else {
                    _showActions(context);
                  }
                },
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.more_vert, size: 20),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
