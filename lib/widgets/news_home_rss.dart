import 'package:flutter/material.dart';

import '../models/rss_feed.dart';

class NewsHomeRss extends StatelessWidget {
  final List<RssFeed> feeds;
  final bool isLoading;
  final VoidCallback onAddFeed;
  final Future<void> Function(int index) onDeleteFeed;
  final Future<void> Function() onRefresh;

  const NewsHomeRss({
    super.key,
    required this.feeds,
    required this.isLoading,
    required this.onAddFeed,
    required this.onDeleteFeed,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        Card(
          elevation: 1,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'RSSフィード',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),
                Text(
                  'ニュースを取得するRSSを管理できます。',
                  style: TextStyle(
                    color: Theme.of(context).brightness == Brightness.dark
                        ? Colors.grey.shade400
                        : Colors.grey.shade600,
                  ),
                ),
                const SizedBox(height: 18),
                ...List.generate(feeds.length, (index) {
                  final feed = feeds[index];

                  return Card(
                    margin: const EdgeInsets.only(bottom: 10),
                    color: Theme.of(context).colorScheme.surfaceContainer,
                    elevation: 0,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(
                        children: [
                          const CircleAvatar(child: Icon(Icons.rss_feed)),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  feed.name,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 16,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  feed.url,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Colors.grey,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          IconButton(
                            onPressed: () => onDeleteFeed(index),
                            icon: const Icon(Icons.delete_outline),
                            tooltip: '削除',
                          ),
                        ],
                      ),
                    ),
                  );
                }),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: onAddFeed,
                    icon: const Icon(Icons.add),
                    label: const Text(
                      'RSSを追加',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: isLoading ? null : onRefresh,
                    icon: const Icon(Icons.refresh),
                    label: const Text('RSSからニュースを更新'),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 80),
      ],
    );
  }
}
