import 'package:flutter/material.dart';

import '../models/rss_feed.dart';
import '../services/rss_service.dart';

class NewsHomeFeedDialogs {
  const NewsHomeFeedDialogs._();

  static Future<RssFeed?> showAddFeed(BuildContext context) async {
    return await showDialog<RssFeed>(
      context: context,
      barrierDismissible: false,
      builder: (context) {
        return const _AddFeedDialog();
      },
    );
  }

  static Future<bool> showDeleteFeed(
    BuildContext context,
    String feedName,
  ) async {
    return await showDialog<bool>(
          context: context,
          builder: (context) {
            return AlertDialog(
              title: const Text('RSSを削除'),
              content: Text('「$feedName」を削除しますか？'),
              actions: [
                TextButton(
                  onPressed: () {
                    Navigator.pop(context, false);
                  },
                  child: const Text('キャンセル'),
                ),
                FilledButton(
                  onPressed: () {
                    Navigator.pop(context, true);
                  },
                  child: const Text('削除'),
                ),
              ],
            );
          },
        ) ??
        false;
  }
}

class _AddFeedDialog extends StatefulWidget {
  const _AddFeedDialog();

  @override
  State<_AddFeedDialog> createState() => _AddFeedDialogState();
}

class _AddFeedDialogState extends State<_AddFeedDialog> {
  late final TextEditingController _nameController;
  late final TextEditingController _urlController;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController();
    _urlController = TextEditingController();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _urlController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('RSSを追加'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _nameController,
            enabled: !_isLoading,
            decoration: const InputDecoration(
              labelText: 'RSSタイトル',
              hintText: '任意',
              hintStyle: TextStyle(color: Colors.grey),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _urlController,
            enabled: !_isLoading,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: 'RSS URL',
              hintText: 'https://example.com/rss.xml',
            ),
          ),
          if (_isLoading)
            const Padding(
              padding: EdgeInsets.only(top: 16),
              child: LinearProgressIndicator(),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _isLoading
              ? null
              : () {
                  Navigator.pop(context);
                },
          child: const Text('キャンセル'),
        ),
        FilledButton(
          onPressed: _isLoading ? null : _onAdd,
          child: const Text('追加'),
        ),
      ],
    );
  }

  Future<void> _onAdd() async {
    final url = _urlController.text.trim();
    if (url.isEmpty) {
      return;
    }

    String name = _nameController.text.trim();

    if (name.isEmpty) {
      setState(() {
        _isLoading = true;
      });

      try {
        final fetchedTitle = await RssService.fetchFeedTitle(url);
        if (fetchedTitle != null) {
          name = fetchedTitle;
        }
      } catch (_) {
        // タイトル取得失敗時は空のまま続行
      } finally {
        if (mounted) {
          setState(() {
            _isLoading = false;
          });
        }
      }
    }

    if (!mounted) return;

    Navigator.pop(context, RssFeed(name: name, url: url));
  }
}
