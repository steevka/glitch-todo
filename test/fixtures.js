// Synthetic Walmart-like product pages. Real pages carry the same two data
// blocks: a Next.js __NEXT_DATA__ script and a schema.org JSON-LD Product.
'use strict';

function productPage({
  itemId = '18235967161',
  name = 'Sony PlayStation 5 Pro Console',
  price = 477.04,
  status = 'IN_STOCK',
  seller = 'Walmart.com',
  condition = 'Open box',
  ld = true,
  next = true,
  nextOverride = null,
  ldAvailability = null,
  extraProductFields = {},
  carousel = true,
} = {}) {
  const product = Object.assign(
    {
      usItemId: itemId,
      name,
      availabilityStatus: status,
      sellerName: seller,
      sellerDisplayName: seller,
      conditionType: condition,
      priceInfo: { currentPrice: { price, priceString: '$' + price.toFixed(2) }, wasPrice: { price: 1394 } },
    },
    extraProductFields
  );
  const nextData = nextOverride || {
    props: {
      pageProps: {
        initialData: {
          data: {
            product,
            // Recommendation carousel: other products, some cheap and in stock.
            contentLayout: carousel
              ? {
                  modules: [
                    {
                      products: [
                        { usItemId: '999', name: 'PS5 Slim', availabilityStatus: 'IN_STOCK', priceInfo: { currentPrice: { price: 399 } } },
                        { usItemId: '998', name: 'Controller', availabilityStatus: 'IN_STOCK', priceInfo: { currentPrice: { price: 59 } } },
                      ],
                    },
                  ],
                }
              : null,
          },
        },
      },
    },
  };
  const ldAvail =
    ldAvailability || (/IN_STOCK|LIMITED/.test(status) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock');
  const ldJson = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    sku: itemId,
    offers: [
      {
        '@type': 'Offer',
        price: price.toFixed(2),
        priceCurrency: 'USD',
        availability: ldAvail,
        itemCondition: 'https://schema.org/UsedCondition',
        seller: { '@type': 'Organization', name: seller },
      },
    ],
  };
  return `<!doctype html><html><head><title>${name} - Walmart.com</title>
${ld ? `<script type="application/ld+json" data-seo-id="schema-org-product">${JSON.stringify(ldJson)}</script>` : ''}
</head><body><div id="__next"><h1>${name}</h1>
<button data-automation-id="atc">Add to cart</button><button>Buy now</button></div>
${next ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>` : ''}
</body></html>`;
}

function blockedPage() {
  return `<!doctype html><html><head><title>Robot or human?</title></head><body>
<h1>Robot or human?</h1><p>Activate and hold the button to confirm that you're human. Thank You!</p>
<div id="px-captcha"></div></body></html>`;
}

module.exports = { productPage, blockedPage };
