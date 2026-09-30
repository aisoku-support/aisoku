import 'dart:async';

import 'package:flutter/material.dart';

import '../models/rss_discovery_candidate.dart';
import '../models/rss_feed.dart';
import '../services/rss_discovery_service.dart';

class RssDiscoverySheet extends StatefulWidget {
  const RssDiscoverySheet({
    super.key,
    required this.articleUrl,
    required this.sourceName,
    required this.isRegistered,
    required this.addFeed,
    required this.onRegistered,
    this.discoveryService = const RssDiscoveryService(),
  });

  final String articleUrl;
  final String sourceName;
  final bool Function(String url) isRegistered;
  final Future<void> Function(RssFeed feed) addFeed;
  final VoidCallback onRegistered;
  final RssDiscoveryService discoveryService;

  @override
  State<RssDiscoverySheet> createState() => _RssDiscoverySheetState();
}

class _RssDiscoverySheetState extends State<RssDiscoverySheet> {
  bool _loading = true;
  bool _registering = false;
  String? _message;
  List<RssDiscoveryCandidate> _candidates = const [];
  Timer? _failureDismissTimer;

  @override
  void initState() {
    super.initState();
    _discover();
  }

  Future<void> _discover() async {
    try {
      final candidates = await widget.discoveryService.discover(
        articleUrl: widget.articleUrl,
        sourceName: widget.sourceName,
      );
      if (!mounted) return;
      final marked = candidates
          .map(
            (candidate) => candidate.copyWith(
              isRegistered: widget.isRegistered(candidate.url),
            ),
          )
          .toList();
      final available = marked.where((candidate) => !candidate.isRegistered);
      if (available.isEmpty) {
        final message = marked.isEmpty ? 'RSSを登録できませんでした' : 'このサイトのRSSは登録済みです';
        if (marked.isEmpty) {
          _showFailure();
        } else {
          setState(() {
            _loading = false;
            _message = message;
            _candidates = marked;
          });
        }
        return;
      }
      if (marked.length == 1) {
        setState(() {
          _loading = false;
          _candidates = marked;
        });
        await _register(marked.single);
        return;
      }
      setState(() {
        _loading = false;
        _candidates = marked;
      });
    } catch (_) {
      if (!mounted) return;
      _showFailure();
    }
  }

  Future<void> _register(RssDiscoveryCandidate candidate) async {
    if (candidate.isRegistered || _registering) return;
    setState(() => _registering = true);
    try {
      await widget.addFeed(
        RssFeed(name: _titleFor(candidate), url: candidate.url),
      );
      widget.onRegistered();
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      _showFailure(registering: false);
    }
  }

  String _titleFor(RssDiscoveryCandidate candidate) {
    if (candidate.title.trim().isNotEmpty) return candidate.title;
    if (widget.sourceName.trim().isNotEmpty) return widget.sourceName;
    return Uri.tryParse(candidate.url)?.host ?? candidate.url;
  }

  void _showFailure({bool registering = false}) {
    _failureDismissTimer?.cancel();
    setState(() {
      _loading = false;
      _registering = registering;
      _message = 'RSSを登録できませんでした';
    });
    _failureDismissTimer = Timer(const Duration(seconds: 3), () async {
      if (!mounted) return;
      final dismissed = await Navigator.of(context).maybePop();
      if (!mounted || dismissed) return;
      setState(() => _message = null);
    });
  }

  @override
  void dispose() {
    _failureDismissTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: _loading || _registering
            ? SizedBox(
                height: 128,
                child: Center(
                  child: Text(_registering ? 'RSSを登録しています…' : 'RSSを探しています…'),
                ),
              )
            : _message != null
            ? SizedBox(height: 128, child: Center(child: Text(_message!)))
            : Column(
                mainAxisSize: MainAxisSize.min,
                children: _candidates.map((candidate) {
                  return ListTile(
                    title: Text(_titleFor(candidate)),
                    trailing: candidate.isRegistered
                        ? const Text('登録済み')
                        : null,
                    enabled: !candidate.isRegistered,
                    onTap: candidate.isRegistered
                        ? null
                        : () => _register(candidate),
                  );
                }).toList(),
              ),
      ),
    );
  }
}
