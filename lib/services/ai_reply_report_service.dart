import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/ai_reply_report.dart';

class AiReplyReportService {
  static const _reporterIdKey = 'ai_reply_reporter_id';
  static Future<String>? _reporterIdFuture;

  static Future<String> _getReporterId() =>
      _reporterIdFuture ??= _loadOrCreateReporterId();

  static Future<String> _loadOrCreateReporterId() async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getString(_reporterIdKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final random = Random.secure();
    final id = List.generate(
      32,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    await prefs.setString(_reporterIdKey, id);
    return id;
  }

  static Future<void> save(
    AiReplyReport report, {
    SupabaseClient? client,
  }) async {
    final data = report.toJson();
    data['reporter_id'] = await _getReporterId();
    await (client ?? Supabase.instance.client).rpc(
      'save_ai_reply_report',
      params: {for (final entry in data.entries) 'p_${entry.key}': entry.value},
    );
  }
}
