import 'package:flutter/material.dart';

import '../services/hidden_sites_service.dart';

class HiddenSitesManagementPage extends StatefulWidget {
  const HiddenSitesManagementPage({super.key});

  @override
  State<HiddenSitesManagementPage> createState() =>
      _HiddenSitesManagementPageState();
}

class _HiddenSitesManagementPageState extends State<HiddenSitesManagementPage> {
  Map<String, String> _hiddenSites = {};
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadHiddenSites();
  }

  Future<void> _loadHiddenSites() async {
    final sites = await HiddenSitesService.getHiddenSiteNames();
    if (mounted) {
      setState(() {
        _hiddenSites = sites;
        _isLoading = false;
      });
    }
  }

  Future<void> _unhideSite(String host) async {
    await HiddenSitesService.unhide(host);
    await _loadHiddenSites();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('非表示にしたサイト')),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _hiddenSites.isEmpty
          ? _buildEmptyState()
          : ListView.separated(
              itemCount: _hiddenSites.length,
              separatorBuilder: (context, index) => const Divider(height: 1),
              itemBuilder: (context, index) {
                final entry = _hiddenSites.entries.elementAt(index);
                return ListTile(
                  title: Text(entry.value),
                  subtitle: Text(
                    entry.key,
                    style: const TextStyle(fontSize: 12),
                  ),
                  trailing: IconButton(
                    icon: const Icon(Icons.close),
                    tooltip: '非表示を解除',
                    onPressed: () => _unhideSite(entry.key),
                  ),
                );
              },
            ),
    );
  }

  Widget _buildEmptyState() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.visibility_off_outlined,
            size: 64,
            color: isDark ? Colors.grey.shade700 : Colors.grey.shade300,
          ),
          const SizedBox(height: 16),
          const Text(
            '非表示にしたサイトはありません',
            style: TextStyle(color: Colors.grey, fontSize: 16),
          ),
        ],
      ),
    );
  }
}
