import 'package:flutter/material.dart';

import '../models/news_item.dart';

class NewsCard extends StatelessWidget {
  final NewsItem? news; // null の場合は Skeleton として表示
  final bool isSaved;
  final VoidCallback? onSave;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Animation<double>? animation; // ニュース表示時のフェード用

  const NewsCard({
    super.key,
    this.news,
    this.isSaved = false,
    this.onSave,
    this.onTap,
    this.onLongPress,
    this.animation,
  });

  @override
  Widget build(BuildContext context) {
    final bool isSkeleton = news == null;
    final isDark = Theme.of(context).brightness == Brightness.dark;

    final Widget cardContent = isSkeleton
        ? _buildSkeletonContent(context)
        : _buildRealContent(context);

    final Widget card = SizedBox(
      height: 82,
      child: Card(
        margin: const EdgeInsets.only(bottom: 4),
        elevation: isSkeleton ? 0 : 1,
        color: isSkeleton
            ? (isDark ? Colors.grey.shade800 : Colors.grey.shade200)
            : Theme.of(context).cardColor,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        child: isSkeleton
            ? cardContent
            : InkWell(
                onTap: onTap,
                onLongPress: onLongPress,
                borderRadius: BorderRadius.circular(8),
                child: cardContent,
              ),
      ),
    );

    if (animation != null) {
      return FadeTransition(opacity: animation!, child: card);
    }

    return card;
  }

  Widget _buildRealContent(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            height: 44,
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                news!.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                  height: 1.3,
                ),
              ),
            ),
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 20,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Text(
                    news!.displayTime,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: isDark
                          ? Colors.grey.shade400
                          : Colors.grey.shade600,
                      fontSize: 11,
                      height: 1.0,
                    ),
                  ),
                ),
                GestureDetector(
                  onTap: onSave,
                  behavior: HitTestBehavior.opaque,
                  child: Icon(
                    isSaved ? Icons.bookmark : Icons.bookmark_border,
                    size: 16,
                    color: isSaved ? Colors.blue : Colors.grey,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSkeletonContent(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final skeletonColor = isDark ? Colors.grey.shade700 : Colors.grey.shade300;

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 60,
                height: 10,
                decoration: BoxDecoration(
                  color: skeletonColor,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 8),
              Container(
                width: 40,
                height: 10,
                decoration: BoxDecoration(
                  color: skeletonColor,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            height: 12,
            decoration: BoxDecoration(
              color: skeletonColor,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(height: 6),
          LayoutBuilder(
            builder: (context, constraints) {
              return Container(
                width: constraints.maxWidth * 0.7,
                height: 12,
                decoration: BoxDecoration(
                  color: skeletonColor,
                  borderRadius: BorderRadius.circular(2),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}
