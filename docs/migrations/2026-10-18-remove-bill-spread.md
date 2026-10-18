# 2026-10-18: Removed saved bill spread data (ABU-91)

One-off clean-up after bill spread was removed from the app and server
(https://github.com/jasmine-nguyen/abundo/pull/853). The script
`scripts/migrations/remove_bill_spread_data.py` ran against the live database
after the server release, then was deleted.

## Result

| Run | budgets_found | budgets_cleaned | rules_found | rules_cleaned | skipped |
| --- | --- | --- | --- | --- | --- |
| Preview | 1 | 0 | 152 | 0 | 0 |
| `--apply` | 1 | 1 | 152 | 152 | 0 |
| Re-check | 0 | 0 | 0 | 0 | 0 |

## What was deleted

The only real spread was on the **Insurance** budget:

| Field | Value |
| --- | --- |
| spread_amount | 1311.91 |
| spread_cycles | 12 |
| spread_from | 2026-08-27 |
| spread_len | 30 |
| spread_paydate | 2026-07-28 |

Every rule only held `spread: False`, an "off" setting with no other data. The
152 rule IDs it was removed from:

- `074b924eba621d3c`
- `08659366892e7800`
- `09f68dafd018ee8e`
- `0de06b2f3138521f`
- `0f21c4c77db75190`
- `0f73c11f850c28dc`
- `11b41c65e8c3909f`
- `12286b56c8c6a76e`
- `127a39558aab4a4e`
- `147bb741d6df41a4`
- `14bed5cac74f8edb`
- `14f3179964b96e54`
- `15767f10c73966dd`
- `19db7959c9a2c613`
- `1a1408b2e2cf5ef0`
- `1e6c154ef22ef804`
- `1ee052621a0a5026`
- `201eaa965f59eccd`
- `235f1f2d8fb98163`
- `25acb9212082520a`
- `285c25c1eefbda95`
- `2a2522c533f727a2`
- `2a3f1e45acdd5fe3`
- `2c4443cbfc1de7c2`
- `2d52533390905aba`
- `3040da37f8f7646c`
- `314078c8e396c830`
- `315405f185d5ceca`
- `328ae71d8e6943fc`
- `3330ca712d4e1bb9`
- `33703c9772d8231b`
- `35f96b5ead772138`
- `3785ac700aad6081`
- `37900805d9d0d305`
- `38eef0c87c389b85`
- `394568b09c5d9eac`
- `3a588687a90e989e`
- `3affb28842388257`
- `3d2cf7e2360c5fe2`
- `3df041399edfbc8b`
- `3fe5154d38c5d763`
- `4180a1dfc688cf7a`
- `4342352fbb0006e4`
- `4580f8dd4fad9ea3`
- `46c5dd5754fb526d`
- `46e24656c01fbb42`
- `48d0a288a60c8388`
- `4abfc8ef84fb41e1`
- `50880eeb59b2a950`
- `51a4f9bc0f107d94`
- `51bc1678469c5ca9`
- `51ef6d5054960587`
- `534b00f17d92b5c0`
- `566573f30071dd29`
- `56734be98741e750`
- `580bf07128e58f51`
- `59278c72b7624fdb`
- `5c9305670d836174`
- `5e85cf3a879ac812`
- `609a9bca02ab905a`
- `60b2f097bf4dacd5`
- `626aa694e310eacc`
- `6526f1bee52c4327`
- `6537733ff2c3c40f`
- `6569babb5b9aa009`
- `66934aac0a755f56`
- `6877f0399cab19e8`
- `6b6dd38d37c75ee8`
- `6e1ca2731d232db9`
- `709b6ced5e7bcf10`
- `719ee512c245c721`
- `73305e0ccffd10a9`
- `73a0b9c1d02eea87`
- `76a7e785d34c5867`
- `77f3838221690fb9`
- `7a32ea4450bf1792`
- `7baf5470831065a4`
- `7ca79a9bcbac4c69`
- `80d2d9374229a11c`
- `8351bdde223ab733`
- `87aa15c5256f5ba3`
- `8849addf1150b951`
- `88e6c743dcd41716`
- `8d37c1927319259d`
- `8d5c2f2d4fd6094a`
- `8db236ce9ad78e35`
- `8fa2d84e6fe38a33`
- `90374de091fddfa4`
- `91062f0d1a4a940f`
- `91a6d611ae2b903e`
- `95ecd5cd63da6b1f`
- `9853cfbbd85b14fd`
- `9a9d5aa65b3b8ce8`
- `9ae3925e403f3dd8`
- `9d891dacec562f0d`
- `9dea70725faac1b5`
- `9e95da29f033da90`
- `a08e892aa13fbbdf`
- `a2e5e8ed2840d3ae`
- `a48a7dcc803586ce`
- `a4f5d305c3ef12a1`
- `a7efaf25374eded0`
- `a9b9887c0d99ad37`
- `aabc8fd04d7f92fb`
- `ab37fd5f6f38907e`
- `ac81e92280f6dd85`
- `acd450071915fe24`
- `aded1bac8ec28fbd`
- `af1fdb00d66681d0`
- `b007cf814f5dadfb`
- `b09e71674f748a5f`
- `b316b21ca768b7ca`
- `b38847fe65254300`
- `b3badb41a7ee57af`
- `b458c69b68991a93`
- `b60270d83600caeb`
- `b6134ae7b3c54bec`
- `b8652deeb993ce3c`
- `b8f6896755e74d24`
- `bc84c9362ff3558c`
- `be3cac3d4fa93696`
- `beef638bae89ac4d`
- `bf67fb33ab95164c`
- `c17be56970a8f476`
- `c3f51210ab73f957`
- `c5e3fbf4d7a036d4`
- `c8d17ee837f1ab0b`
- `cef57f5c3fb99f9d`
- `d3cd9ea3287d5d92`
- `d447b47a54da51b0`
- `d50e0d2d8e5c8ab0`
- `d7155c5d92084d1f`
- `d8d89f02e7264b07`
- `d995151eadd08ecc`
- `dcd9756963c260fa`
- `dd949dba420b3c96`
- `de1b9a3c3a915f34`
- `de692abf0808a1b9`
- `e0db8c1a9e31f692`
- `e2f3e6db683ce0ee`
- `e9aa58f008781e70`
- `ea5327803ff86e08`
- `ef298c7074a8d8b1`
- `f3e8d9010440b77c`
- `f454833400268d9b`
- `f55f0e006758c5e5`
- `f5c9c400f8db1192`
- `f8c816c737cadb4c`
- `f9533bb04f5faba5`
- `f98c7d32c425afb3`
- `fb8f904cbee5c62b`
- `fe01435a10e27905`
