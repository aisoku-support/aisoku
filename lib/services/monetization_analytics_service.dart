import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/ad_identity.dart';

/// Durable, idempotent outbox. No article, prompt, reply or credentials are sent.
class MonetizationAnalyticsService {
  static final instance = MonetizationAnalyticsService();
  static const _key = 'monetization_outbox_v1';
  final List<Map<String, dynamic>> _pending = [];
  Future<void> _serial = Future.value();
  bool _restored = false;
  bool _started = false;
  bool _flushing = false;
  Timer? _retry;
  final Future<String?> Function()? readStorage;
  final Future<void> Function(String)? writeStorage;
  final Future<void> Function(List<Map<String, dynamic>>)? sendBatch;

  MonetizationAnalyticsService({
    this.readStorage,
    this.writeStorage,
    this.sendBatch,
  });

  Future<void> start() async {
    _started = true;
    await resume();
  }

  void record(String kind, String entityId, Map<String, Object?> data) {
    final event = <String, dynamic>{
      'eventId': newMeasurementId(),
      'kind': kind,
      'entityId': entityId,
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
      'isTest': !kReleaseMode,
      'data': Map<String, Object?>.from(data),
    };
    _pending.add(event);
    if (!_started) return;
    _serial = _serial
        .then((_) async {
          await _restore();
          await _persist();
        })
        .catchError((Object _) {
          _scheduleRetry();
        });
    unawaited(_serial.then((_) => _flush()));
  }

  void ad(
    String kind,
    AdIdentity identity, [
    Map<String, Object?> extra = const {},
  ]) {
    record(kind, identity.adInstanceId, {...identity.toJson(), ...extra});
  }

  Future<void> resume() async {
    if (!_started) return;
    _serial = _serial
        .then((_) async {
          await _restore();
          await _persist();
        })
        .catchError((Object _) {
          _scheduleRetry();
        });
    await _serial;
    await _flush();
  }

  Future<void> _restore() async {
    if (_restored) return;
    final saved = readStorage != null
        ? await readStorage!()
        : (await SharedPreferences.getInstance()).getString(_key);
    if (saved != null) {
      final ids = _pending.map((e) => e['eventId']).toSet();
      _pending.insertAll(
        0,
        (jsonDecode(saved) as List).cast<Map<String, dynamic>>().where(
          (e) => !ids.contains(e['eventId']),
        ),
      );
    }
    _restored = true;
  }

  Future<void> _persist() async {
    if (writeStorage != null) {
      await writeStorage!(jsonEncode(_pending));
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(_pending));
  }

  Future<void> _flush() async {
    if (_flushing || !_restored || !_started) return;
    _flushing = true;
    try {
      while (_pending.isNotEmpty) {
        final batch = _pending.take(50).toList();
        if (sendBatch != null) {
          await sendBatch!(batch);
        } else {
          await Supabase.instance.client
              .rpc('record_monetization_events', params: {'p_events': batch})
              .timeout(const Duration(seconds: 15));
        }
        _serial = _serial.then((_) async {
          final ids = batch.map((e) => e['eventId']).toSet();
          _pending.removeWhere((e) => ids.contains(e['eventId']));
          await _persist();
        });
        await _serial;
      }
      _retry?.cancel();
      _retry = null;
    } catch (_) {
      _scheduleRetry();
    } finally {
      _flushing = false;
    }
  }

  void _scheduleRetry() {
    if (!_started) return;
    _retry ??= Timer(const Duration(seconds: 30), () {
      _retry = null;
      unawaited(resume());
    });
  }

  void dispose() {
    _started = false;
    _retry?.cancel();
    _retry = null;
  }
}
