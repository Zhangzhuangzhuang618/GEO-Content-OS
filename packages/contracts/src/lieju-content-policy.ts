export function findLiejuProhibitedPromotionalTerms(value: string): readonly string[] {
  const matches =
    value.match(
      /(?:最好|最佳|首选|权威|国家级|百分百|100%保证|(?:行业|业内|全网|全国|全市|本地|当地|同城|市场|区域|广州|华南|排名)第一|第一(?:名|家|品牌|选择|梯队|服务商|搬家公司)|(?:是|为|称为|号称|自称|公认|位居|稳居|做到|成为)第一(?=$|[\s，。！？；：]))/gu,
    ) ?? [];

  return Object.freeze([...new Set(matches)]);
}
