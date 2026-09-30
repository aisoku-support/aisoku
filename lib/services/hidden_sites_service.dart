import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class HiddenSitesService {
  static const String _hostsKey = 'hidden_site_hosts';
  static const String _namesKey = 'hidden_site_names';

  static String normalizeHost(String url) {
    if (url.isEmpty) return '';
    try {
      String workingUrl = url;
      if (!workingUrl.contains('://')) {
        workingUrl = 'http://$workingUrl';
      }
      final uri = Uri.parse(workingUrl);
      String host = uri.host.toLowerCase();
      return host.replaceFirst(RegExp(r'^www\.'), '');
    } catch (_) {
      return '';
    }
  }

  static Future<Set<String>> getHiddenHosts() async {
    final prefs = await SharedPreferences.getInstance();
    return (prefs.getStringList(_hostsKey) ?? []).toSet();
  }

  static Future<Map<String, String>> getHiddenSiteNames() async {
    final prefs = await SharedPreferences.getInstance();
    final jsonStr = prefs.getString(_namesKey);
    if (jsonStr == null) return {};
    try {
      return Map<String, String>.from(jsonDecode(jsonStr));
    } catch (_) {
      return {};
    }
  }

  static Future<void> hide(String host, String name) async {
    final prefs = await SharedPreferences.getInstance();

    final hosts = (prefs.getStringList(_hostsKey) ?? []).toSet();
    hosts.add(host);
    await prefs.setStringList(_hostsKey, hosts.toList());

    final names = await getHiddenSiteNames();
    names[host] = name;
    await prefs.setString(_namesKey, jsonEncode(names));
  }

  static Future<void> unhide(String host) async {
    final prefs = await SharedPreferences.getInstance();

    final hosts = (prefs.getStringList(_hostsKey) ?? []).toSet();
    if (hosts.remove(host)) {
      await prefs.setStringList(_hostsKey, hosts.toList());
    }

    final names = await getHiddenSiteNames();
    if (names.containsKey(host)) {
      names.remove(host);
      await prefs.setString(_namesKey, jsonEncode(names));
    }
  }
}
