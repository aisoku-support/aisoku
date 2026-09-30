import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/rss_discovery_candidate.dart';

class RssDiscoveryService {
  const RssDiscoveryService();

  Future<List<RssDiscoveryCandidate>> discover({
    required String articleUrl,
    String? sourceName,
  }) async {
    final client = Supabase.instance.client;
    final functionName = 'discover-rss-feed';

    try {
      final response = await client.functions.invoke(
        functionName,
        body: {'url': articleUrl, 'source_name': sourceName},
      );

      if (response.status != 200 || response.data is! Map) {
        throw Exception('RSS探索に失敗しました');
      }

      final data = Map<String, dynamic>.from(response.data as Map);
      final rawCandidates = data['candidates'];

      if (rawCandidates is! List) {
        return [];
      }

      final candidates = rawCandidates
          .whereType<Map>()
          .map((value) {
            final candidate = Map<String, dynamic>.from(value);
            return RssDiscoveryCandidate(
              url: candidate['url'] as String? ?? '',
              title: candidate['title'] as String? ?? '',
              isRegistered: false,
            );
          })
          .where((candidate) => candidate.url.isNotEmpty)
          .toList();

      return candidates;
    } catch (_) {
      rethrow;
    }
  }
}
