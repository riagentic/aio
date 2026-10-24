// CPace vectors shared by the three implementations' tests (server TS, the
// Electron client's embedded copy, the Android Kotlin port).
// ── draft-irtf-cfrg-cpace-21, Appendix B.1 ──────────────────────────────
export const DRAFT = {
  PRS: "Password",
  CI: "0b415f696e69746961746f720b425f726573706f6e646572",
  sid: "7e4b4791d6a8ef019b936c79fb7f2c57",
  genStr: "0843506163653235350850617373776f72646d000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000180b415f696e69746961746f" +
    "720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f" +
    "2c57",
  g: "d04bf6d41f6a289632a2e929fa29bebd51092512a7829fdde7d314b62f05a73f",
  ya: "21b4f4bd9e64ed355c3eb676a28ebedaf6d8f17bdc365995b319097153044080",
  ADa: "ADa",
  Ya: "1d13c89278cdadd826f6d8d7f887701430f8380ddc17611cdd6dc989ce0c9f32",
  yb: "848b0779ff415f0af4ea14df9dd1d3c29ac41d836c7808896c4eba19c51ac40a",
  ADb: "ADb",
  Yb: "248cccf6d5cdc3646f0ad593f9e6cef4e69d4945f8372e623512ecea32185623",
  K: "5b067effbdc0b2a0e1d907b21ebb25cfedb96a852179a847c37e43ee71322c6b",
  ISK_IR: "6e19b875f7a561d6b3ca3dbb9ef42ac55de3e717881018204b8922b4" +
    "d5e53bb2aa82c300bea7b65d2b671da71922ddf6472301b79bc270ad" +
    "fa8bf413285f2263",
  // B.1.10: s, then [u, q] — q all zero is the abort case.
  lowOrderS: "af46e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449aff",
  lowOrder: [
    ["0000000000000000000000000000000000000000000000000000000000000000", "0"],
    ["0100000000000000000000000000000000000000000000000000000000000000", "0"],
    ["ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "0"],
    ["e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "0"],
    ["5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", "0"],
    ["edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "0"],
    [
      "daffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "d8e2c776bbacd510d09fd9278b7edcd25fc5ae9adfba3b6e040e8d3b71b21806",
    ],
    ["eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "0"],
    [
      "dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "c85c655ebe8be44ba9c0ffde69f2fe10194458d137f09bbff725ce58803cdb38",
    ],
    [
      "d9ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "db64dafa9b8fdd136914e61461935fe92aa372cb056314e1231bc4ec12417456",
    ],
    [
      "cdeb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880",
      "e062dcd5376d58297be2618c7498f55baa07d7e03184e8aada20bca28888bf7a",
    ],
    [
      "4c9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f11d7",
      "993c6ad11c4c29da9a56f7691fd0ff8d732e49de6250b6c2e80003ff4629a175",
    ],
  ],
};

// ── aio's application layer: one golden vector for all three ports ──────
// pin "12345678", the draft's ya/yb/sid, fp = SHA-256("aio-pair test leaf"),
// box sealed with iv 00..0b over the profile text {"aio":1}.
export const AIO = {
  pin: "12345678",
  leaf: "aio-pair test leaf",
  fp: "325c659121f6545ed9e44b6f2a6a0472bb493ba7a33492a76cb48c3e6890c3c6",
  Ya: "5ec9ee607dcb0dfd7259bda9b970a9d4fe503090ee9a16d38b7e4ee48a6afc4b",
  Yb: "d8f6867fce3f0338b7361392e2025669c16fcb8e159630fddacdf4b0efc9f143",
  ta: "ec302b0f0ed40d61da78db62a6cc9ae95ee04023653140ae79b14d041f6e1383" +
    "5ed4f9f027e302eac5bf62710294a35c91ae40604ebb51e4f188404f522cd72b",
  tb: "ba70b91a7794b7d0ded73401ef4edbb238d1c9921eb30f1bafa65f5d559fbb09" +
    "93dca8ae4e28b870c89e8d74d282cb9c73025d515c761b01dfce9afd5d3c2683",
  iv: "000102030405060708090a0b",
  profile: '{"aio":1}',
  box: "000102030405060708090a0b250d66683eb7167e365b72df0baa2be26ef48987" +
    "f31b624b95",
};
