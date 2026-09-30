class RssFeed {
  final String name;
  final String url;
  final String? category;
  final int? displayOrder;
  final bool isPreset;

  const RssFeed({
    required this.name,
    required this.url,
    this.category,
    this.displayOrder,
    this.isPreset = false,
  });

  factory RssFeed.fromJson(Map<String, dynamic> json, {bool isPreset = false}) {
    return RssFeed(
      name: json['source_name'] ?? 'ニュース',
      url: json['url'] ?? '',
      category: json['category'] as String?,
      displayOrder: json['display_order'] as int?,
      isPreset: isPreset,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'source_name': name,
      'url': url,
      'category': category,
      'display_order': displayOrder,
    };
  }

  RssFeed copyWith({
    String? name,
    String? url,
    String? category,
    int? displayOrder,
    bool? isPreset,
  }) {
    return RssFeed(
      name: name ?? this.name,
      url: url ?? this.url,
      category: category ?? this.category,
      displayOrder: displayOrder ?? this.displayOrder,
      isPreset: isPreset ?? this.isPreset,
    );
  }
}
