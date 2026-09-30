import 'package:flutter/material.dart';

import '../models/topic_source_article.dart';

class TopicSourceSheet extends StatefulWidget {
  const TopicSourceSheet({
    super.key,
    required this.topicTitle,
    required this.load,
  });
  final String topicTitle;
  final Future<List<TopicSourceArticle>> Function() load;
  @override
  State<TopicSourceSheet> createState() => _TopicSourceSheetState();
}

class _TopicSourceSheetState extends State<TopicSourceSheet> {
  static const _pageSize = 5;
  Future<List<TopicSourceArticle>>? _future;
  int _page = 0;

  void _startLoading() {
    final future = widget.load();
    if (!mounted) return;
    setState(() {
      _future = future;
    });
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: FutureBuilder<List<TopicSourceArticle>>(
      future: _future,
      builder: (context, snapshot) {
        if (_future == null) {
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(title: Text(widget.topicTitle)),
              ListTile(title: const Text('ソース ＞'), onTap: _startLoading),
            ],
          );
        }
        if (snapshot.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.all(32),
            child: CircularProgressIndicator(),
          );
        }
        if (snapshot.hasError || (snapshot.data ?? const []).isEmpty) {
          return const Padding(
            padding: EdgeInsets.all(24),
            child: Text('ソース情報を取得できませんでした。'),
          );
        }
        final articles = snapshot.data!;
        final page = articles.skip(_page * _pageSize).take(_pageSize).toList();
        final pages = (articles.length + _pageSize - 1) ~/ _pageSize;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(widget.topicTitle),
              subtitle: const Text('ソース'),
            ),
            ...page.map(
              (article) => ListTile(
                title: Text(article.sourceName),
                subtitle: Text(article.title),
                onTap: () => Navigator.pop(context, article),
              ),
            ),
            if (pages > 1)
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IconButton(
                    onPressed: _page == 0
                        ? null
                        : () => setState(() => _page--),
                    icon: const Icon(Icons.chevron_left),
                  ),
                  Text('${_page + 1} / $pages'),
                  IconButton(
                    onPressed: _page + 1 >= pages
                        ? null
                        : () => setState(() => _page++),
                    icon: const Icon(Icons.chevron_right),
                  ),
                ],
              ),
          ],
        );
      },
    ),
  );
}
