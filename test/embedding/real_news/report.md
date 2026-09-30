# 実ニュースEmbedding比較用データセット 抽出レポート

抽出日時: 2026-09-26T05:15:18.737Z

## 取得元と方法

- 記事: Upstash Redisの `newsdata:articles` Sorted Setを保存時刻の降順で最大200件取得し、canonical IDから `newsdata:article:<ID>` をMGETで読み取り。
- Topic・統合履歴: Supabase `topic_articles` をarticle_idで読み、`topics` のsubject/event/category等をTopic IDで結合。
- すべて読み取り専用。NewsData API、Gemini Embedding、Upstash Vectorは呼び出していない。
- 公開URL、画像URL、source_name、カテゴリ配列、利用者情報は保存対象外。本文内のURL・メール・電話番号らしき値は伏字化。

## 件数・欠損

- Redis index ID: 200; 取得記事: 200; 不正JSON/shape: 0; payload欠損: 0
- Topic紐付け: 155; subject欠損: 45; event欠損: 45; embedding_input欠損: 45
- Topic match method: {"similarity_merge":8,"new_topic":138,"fallback_singleton":9,"unprocessed_or_missing_link":45}
- Topic数: 148; 同一Topic複数記事グループ: 6; 同一Topic pair候補: 8
- 異Topic・同カテゴリの語彙類似候補: 6（bigram Jaccardによる抽出。正解ラベルではなく、手動確認候補）

## Topic別サンプル分布

| Topic ID | 今回の記事数 | Topic全記事数 |
|---|---:|---:|
| 1e7c8813-5faa-44bb-bfaa-80bdfcd8ca1c | 3 | 3 |
| 5839161a-2303-4ba3-abf5-f5cd699544d4 | 2 | 2 |
| 758b0c72-b2ea-47e0-afaf-cc7eec560cd0 | 2 | 2 |
| 78343614-83a9-4bd3-9f75-e5a2561ae7da | 2 | 2 |
| aa6e6e30-f786-4f83-acbb-f8354f710f37 | 2 | 2 |
| c9b56538-ff20-41f6-b7ef-3e3e4ad6a412 | 2 | 2 |
| 00ffeec2-e922-4d21-a81d-7b8b2f3e95ea | 1 | 1 |
| 013ac0c0-b5df-4439-9a9e-1c8761e5c5d7 | 1 | 1 |
| 03a40daa-07a8-417e-b055-0d7e3c5ec91e | 1 | 1 |
| 04ff6c22-4fb1-4941-9056-0f1a03a90260 | 1 | 1 |
| 052dddc7-d1bd-496a-8e02-0f778389ac83 | 1 | 1 |
| 0916248b-93af-4db9-8879-59af355cbea6 | 1 | 1 |
| 0a292739-b234-4312-8904-e1de03ab9204 | 1 | 1 |
| 0b09be32-aa31-4525-9835-eee70bb4bba7 | 1 | 1 |
| 0b96706d-0e2a-4ea0-85f9-b36e7c79c516 | 1 | 1 |
| 0c841ebe-f4a3-4c0e-867d-b5ded062d8d0 | 1 | 1 |
| 0d436a98-fce2-4a74-a8e2-7c2115432fff | 1 | 1 |
| 0e801598-ce24-4842-ad7a-b0810210138c | 1 | 1 |
| 0f8c4878-f4db-4fc3-afb4-4e651e16190a | 1 | 1 |
| 0fadb930-1516-4bb1-881e-0a9d7f3dc91d | 1 | 1 |
| 10c06596-ae8e-47c9-b484-a7350a13fd16 | 1 | 1 |
| 131f8fae-46a3-4ecf-b10c-7dd00326aad9 | 1 | 1 |
| 14404d3b-3af9-43a8-aebb-1abed4ee208e | 1 | 1 |
| 18cf972a-72e2-4914-a9a2-0e179b282f4c | 1 | 1 |
| 19562807-7d67-40af-a502-b3f2bbcef1ff | 1 | 1 |
| 1ace7966-f798-488f-a7b8-8336c096dff1 | 1 | 1 |
| 1b7a2b17-7933-4418-82ac-1eab4c0a1cf0 | 1 | 1 |
| 1dce93d9-f2a1-407f-a5bc-15baaa505146 | 1 | 1 |
| 20fdbb1f-8e56-4149-b871-52e2b0a438d8 | 1 | 1 |
| 21071a54-da3b-4234-ad8a-3392949e71b6 | 1 | 1 |
| 21104e1f-9359-466e-9889-b8fdbfccc8fe | 1 | 1 |
| 220fcb9a-a4b3-4059-ba37-b49dfdf2290f | 1 | 1 |
| 22a4aa49-6676-4968-8323-a74ff3dd295d | 1 | 1 |
| 231b57a0-f309-4489-bdec-8d0f7d4c25fa | 1 | 1 |
| 24aa1fb8-daf4-4e54-86de-6c5fe0422840 | 1 | 1 |
| 26f108cc-7fdd-44a4-9ab6-eacb5182544a | 1 | 1 |
| 2739a428-7d5a-46af-a0a2-fa3b8ccc6634 | 1 | 1 |
| 27414090-21bc-4207-be64-73d41612af9c | 1 | 1 |
| 281e7195-fdb5-4449-83ff-bb01f36668fa | 1 | 1 |
| 2863cff5-c124-46cb-97bd-c7c1db08f13c | 1 | 1 |
| 2b027684-8a92-4c3c-ae32-533e9434757c | 1 | 1 |
| 2d7ac9f7-dc87-4646-8820-e5b411fbbe1c | 1 | 1 |
| 2ebc0565-a6ca-48be-91c5-e9cbab5414f4 | 1 | 1 |
| 2f65f08f-7d08-4c27-8303-0ad3fcba3169 | 1 | 1 |
| 2fa32c91-1c47-4bb3-9ac5-84c770e1709c | 1 | 1 |
| 319fbe75-7632-49f2-b593-e9915e634b68 | 1 | 1 |
| 32060bcb-8c33-4e1e-89a8-535acf156770 | 1 | 1 |
| 323a9711-13a9-461c-9b73-78caf0ba852a | 1 | 1 |
| 354e701d-af08-41cc-bec3-e9c4fef20416 | 1 | 1 |
| 385dddfb-545b-4203-85e1-2a4f8eb0a41a | 1 | 1 |
| 390a43df-4de2-4c79-a606-745fb23aab93 | 1 | 1 |
| 3af86e47-76c2-4fc2-8f6e-90d8cbbf400f | 1 | 1 |
| 3e2a7e2b-ec8b-40fe-be82-22c14406985d | 1 | 1 |
| 41d99bb3-493c-4156-9597-8e531583bdcf | 1 | 1 |
| 43b466cf-bc31-4e70-b0e3-4f70e26b5db7 | 1 | 1 |
| 45a3f7a0-fefd-4e09-b844-6667301f4494 | 1 | 1 |
| 4a3b8036-1162-48ae-aff7-fbdef706abf6 | 1 | 1 |
| 4aa6cc74-b4de-4997-8eff-53eef53903a2 | 1 | 1 |
| 4ae21608-4526-47a1-8944-af6647d69729 | 1 | 1 |
| 4c1e968e-3ca3-4ebf-b3b7-5fa9019c1177 | 1 | 1 |
| 506693dc-43f3-4aaf-bd77-c8de311401b1 | 1 | 1 |
| 5266d3ac-0a89-4872-bcc5-1938801da576 | 1 | 1 |
| 557a54a4-63ce-49ee-b545-ad5975af9fe3 | 1 | 1 |
| 563faadb-957c-4bf4-a351-f3fc68ea6c70 | 1 | 1 |
| 56c17078-33c3-4de3-8636-c7da00b61cd0 | 1 | 1 |
| 57c332a7-1180-47e0-a434-49a253f04cfd | 1 | 1 |
| 5c54df28-fcc7-4ad7-ac83-ea61912c8258 | 1 | 1 |
| 5c600faa-e9b5-4ca8-9dbc-9108e6244401 | 1 | 1 |
| 5ed06eeb-1aa6-4368-aea6-911223607533 | 1 | 1 |
| 5ef311ba-989c-419d-b23d-16f4ffb88811 | 1 | 1 |
| 60dc1ad5-ce53-4228-a076-3a080798a849 | 1 | 1 |
| 6181e403-cefc-4aec-9d3d-5d3d14345cae | 1 | 2 |
| 6247f89c-4d5f-4c2a-9405-7e722a84048f | 1 | 1 |
| 6637dc5c-1d74-41dc-ab67-e4cc13c89625 | 1 | 1 |
| 6b1da715-0688-421c-908c-01f9ee72314b | 1 | 1 |
| 6cb73e4f-ef4d-4587-9cc6-4440aba2e57c | 1 | 1 |
| 763aac4a-bc3f-4990-b06a-992438553e51 | 1 | 1 |
| 76f166a3-984e-40bb-b7e8-ae82963c64c4 | 1 | 1 |
| 7823d0ee-8761-4cb0-826e-49d0d4406205 | 1 | 1 |
| 79b6fae3-92f6-453f-b20b-0d119e6fa208 | 1 | 1 |
| 7b1301b5-4cc7-4a19-9355-a86d74d7880e | 1 | 1 |
| 7b431dcd-17f0-4024-b3d8-46bd8f695e96 | 1 | 1 |
| 7b64f14f-f903-4c92-ae6d-19863c59fba4 | 1 | 1 |
| 7b7efb3d-e7e5-4207-ae7a-40ff8ea29962 | 1 | 1 |
| 7d9bc034-6a81-4b6f-a984-1f40631a3a65 | 1 | 1 |
| 7e68e91a-6da2-4626-979d-cc2fea023d3b | 1 | 1 |
| 81eb9a9d-b04c-48a6-b8c4-1527be15879a | 1 | 1 |
| 8288c67e-c17a-4151-b576-7f5ca6aefbc3 | 1 | 1 |
| 82e1a596-2913-4734-bd9c-912800633338 | 1 | 1 |
| 8376eb6b-88cd-4ca4-af3a-2bccb848eba1 | 1 | 1 |
| 856d5721-b33d-4090-86e0-468451d3b8b4 | 1 | 1 |
| 861d0873-175c-46c9-8212-c5285564647b | 1 | 1 |
| 8725228b-930a-4288-a10d-80021ac448e9 | 1 | 1 |
| 8891a11a-2d37-415d-bd54-17f6ad1d4a5d | 1 | 1 |
| 8a6df992-b7b3-4068-abc0-355c62e9b0cc | 1 | 1 |
| 8d5795f6-1843-4463-afc1-45ed9121ca23 | 1 | 1 |
| 8da35051-8f74-4281-9d9c-94b532cc2e70 | 1 | 1 |
| 8e263079-2f95-4395-a41f-17fbc78ff824 | 1 | 1 |
| 932769e0-c55c-405f-b9f5-7bfd2b5b9aca | 1 | 1 |
| 94f6812a-e384-4080-8512-a6f09ff929f1 | 1 | 1 |
| 9b6638d0-58eb-4af8-8256-2b27014882ce | 1 | 1 |
| 9e2a5749-0955-4a83-a854-f606139515ac | 1 | 1 |
| a2299b5f-af3d-482c-bfd3-d8e3aac762b6 | 1 | 1 |
| a5f2b1d5-b051-46b6-887e-d709201414eb | 1 | 1 |
| a67be1b5-8c9a-4acb-90e7-351cec884f99 | 1 | 1 |
| a8a87743-d022-41e8-a642-96b055da5df5 | 1 | 1 |
| a8d15226-9967-4a79-aab6-62551052fc7c | 1 | 1 |
| a990b625-7b3e-4116-8921-4af885224e34 | 1 | 1 |
| ab308aec-4696-4efa-b6c4-02716ec87679 | 1 | 1 |
| abe6af47-fe9b-4da9-a96d-0ae5e33faa88 | 1 | 1 |
| af9c3c7f-1784-4f4c-b662-dae61af3a8aa | 1 | 1 |
| b04759e9-ffdb-4b85-8389-752aec0382b2 | 1 | 1 |
| b05ff166-2f7e-437d-828a-0fe3c9968a3e | 1 | 1 |
| b1d444f4-7691-4ec8-bb57-3adc2f7f1d3a | 1 | 1 |
| b926c709-2c3d-41c5-8e26-70b659f97a0b | 1 | 1 |
| b97f070f-5b5e-45ee-a53b-88f3e2e0f74f | 1 | 1 |
| b9b8bcf6-f5a4-4913-bd6f-bb7338e346b1 | 1 | 1 |
| ba6d7d36-0e2d-4475-afdf-e448ded0758d | 1 | 1 |
| bbcd9cb5-879d-4708-9545-4b5ccc4b6dcc | 1 | 1 |
| bd5b9adb-a8fa-4970-ab9e-0bf5789e8483 | 1 | 1 |
| bd7047cf-2a2e-46e3-b713-efc2738996fd | 1 | 1 |
| bedd2b56-d067-4f86-90a4-5a14a789c4f0 | 1 | 1 |
| c0bb36a5-8c12-4ffa-8546-ff55aeeb8ee2 | 1 | 1 |
| c27463d3-6b7d-4c59-bad6-671e7b2deeec | 1 | 1 |
| c4460826-bb95-445f-b7d2-e57ac968c1b8 | 1 | 1 |
| c8b9d92b-8c38-4f51-8c45-97ec0ec5dfa7 | 1 | 1 |
| c9d060df-d9d6-48dc-a063-413681ca43c6 | 1 | 1 |
| ca3568b2-383d-483e-9e96-d5664301b67f | 1 | 1 |
| d659380a-836d-4942-a356-18c7a7292a09 | 1 | 1 |
| da004103-5a10-445a-8e27-5b1781875065 | 1 | 1 |
| dff524cc-5c2c-408a-a1a1-fe05b88f2a58 | 1 | 1 |
| e4e0a137-8d70-4f65-840a-8446eb1aa2fb | 1 | 1 |
| e56c931a-4064-4cbe-acc2-68e47e38ce2f | 1 | 1 |
| e94f683d-8e6f-4890-a595-06c156674bbe | 1 | 1 |
| ea90e789-35c1-4a70-9fb8-0b391a5f3145 | 1 | 1 |
| eb6ea55f-66f4-4a62-a6d6-b5296285a26c | 1 | 1 |
| ec0135f9-0f3c-4ce9-b417-29ee960cf2ca | 1 | 1 |
| ecfd06b2-2964-41df-8901-4ca91d4bb6d1 | 1 | 1 |
| ed2ef4e9-6173-4a7b-8644-156ae7a2bb3e | 1 | 1 |
| edb18a23-e6d4-4567-80a1-de9fb8093962 | 1 | 1 |
| efc1f490-d848-4772-8ab1-a4f687020d79 | 1 | 1 |
| f122866a-cfae-4852-bcaf-204e5ec7ae77 | 1 | 1 |
| f359d287-1f2f-4291-9995-5add1d9384c0 | 1 | 1 |
| f4c8d2c7-427e-489d-bdbe-7dcb0159c7b5 | 1 | 1 |
| f7e734d7-b332-42ee-b7d2-5cfee17b6275 | 1 | 1 |
| f930eab6-78d9-40ad-a256-6922d00bef4a | 1 | 1 |
| f96b8c10-b0b5-4601-a64f-f35acfebaa80 | 1 | 1 |
| fcb679a3-ae01-4369-8933-2ed0f7719737 | 1 | 1 |

## 解釈上の注意

- CURRENT_SPECではEmbedding入力はGemma生成の `subject | event`。Redisには記事情報、Supabase topicsには現在のTopic単位subject/eventが保存されるため、記事ごとの過去Stage 1 subject/eventは復元できない。今回は既存Topicの現在値を利用し、Topic未処理・リンクなし・subject/event欠損は推測で補わずnullとした。
- `similarity_merge` は既存統合履歴の候補であり、過去の統合が正しいとは限らない。正例候補も無条件な正解データとはしない。
- 異なるTopicの語彙類似候補はハードネガティブ候補として抽出し、手動確認前は評価正解ラベルにしない。
- 保存時刻Sorted Setは現行仕様の保持期間により通常直近7日分。Upstash Redisのread-only credentialで読めた範囲を使用。