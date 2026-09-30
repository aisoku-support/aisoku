import 'package:flutter/material.dart';

import '../services/ad_consent_service.dart';
import '../services/theme_service.dart';
import '../models/news_item.dart';
import '../widgets/news_home_rss.dart';
import '../widgets/news_home_saved.dart';
import 'news_home_controller.dart';
import 'hidden_sites_management_page.dart';

class SettingsPage extends StatelessWidget {
  final NewsHomeController controller;
  final void Function(NewsItem) onNewsTap;
  final void Function(NewsItem) onNewsLongPress;
  final Future<void> Function() onAddFeed;
  final Future<void> Function(int) onDeleteFeed;

  const SettingsPage({
    super.key,
    required this.controller,
    required this.onNewsTap,
    required this.onNewsLongPress,
    required this.onAddFeed,
    required this.onDeleteFeed,
  });

  String _getThemeModeLabel(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light:
        return 'ライト';
      case ThemeMode.dark:
        return 'ダーク';
      case ThemeMode.system:
        return '端末の設定に従う';
    }
  }

  void _showThemeDialog(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('外観'),
          content: ListenableBuilder(
            listenable: ThemeService.instance,
            builder: (context, _) {
              final currentMode = ThemeService.instance.themeMode;
              final options = [
                (mode: ThemeMode.system, label: '端末の設定に従う'),
                (mode: ThemeMode.light, label: 'ライト'),
                (mode: ThemeMode.dark, label: 'ダーク'),
              ];
              return Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final option in options)
                    ListTile(
                      title: Text(option.label),
                      leading: Icon(
                        currentMode == option.mode
                            ? Icons.radio_button_checked
                            : Icons.radio_button_off,
                      ),
                      selected: currentMode == option.mode,
                      onTap: () {
                        ThemeService.instance.setThemeMode(option.mode);
                        Navigator.pop(context);
                      },
                    ),
                ],
              );
            },
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('設定')),
      body: ListenableBuilder(
        listenable: Listenable.merge([
          AdConsentService.instance,
          ThemeService.instance,
        ]),
        builder: (context, _) => ListView(
          children: [
            ListTile(
              leading: const Icon(Icons.palette_outlined),
              title: const Text('外観'),
              subtitle: Text(
                _getThemeModeLabel(ThemeService.instance.themeMode),
              ),
              onTap: () => _showThemeDialog(context),
            ),
            ListTile(
              leading: const Icon(Icons.bookmark),
              title: const Text('保存したニュース'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => Scaffold(
                    appBar: AppBar(title: const Text('保存したニュース')),
                    body: ListenableBuilder(
                      listenable: controller,
                      builder: (context, _) => NewsHomeSaved(
                        newsList: controller.allNews,
                        savedUrls: controller.savedUrls,
                        onSave: controller.toggleSaved,
                        onNewsTap: onNewsTap,
                        onNewsLongPress: onNewsLongPress,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.rss_feed),
              title: const Text('RSS登録・管理'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => Scaffold(
                    appBar: AppBar(title: const Text('RSS登録・管理')),
                    body: NewsHomeRss(
                      feeds: controller.userFeeds,
                      isLoading:
                          controller.isLoading || controller.isRefreshing,
                      onAddFeed: () {
                        onAddFeed();
                      },
                      onDeleteFeed: onDeleteFeed,
                      onRefresh: controller.refreshNews,
                    ),
                  ),
                ),
              ),
            ),
            if (AdConsentService.instance.privacyOptionsRequired)
              ListTile(
                leading: const Icon(Icons.privacy_tip_outlined),
                title: const Text('プライバシー設定'),
                onTap: () async {
                  final error = await AdConsentService.instance
                      .showPrivacyOptions();
                  if (error != null && context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('プライバシー設定を開けませんでした。時間をおいてお試しください。'),
                      ),
                    );
                  }
                },
              ),
            ListTile(
              leading: const Icon(Icons.visibility_off_outlined),
              title: const Text('非表示にしたサイト'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (context) => const HiddenSitesManagementPage(),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
