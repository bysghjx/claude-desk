const {test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../ui/src/core/dom.mjs');

test('inline code naming a file becomes a link to it, with the line when given',async()=>{
  const {enhance}=await load();
  assert.equal(enhance('<code>ui/app.css:42</code>'),'<code class="file-ref" data-file-ref="ui/app.css" data-file-line="42" title="打开 ui/app.css">ui/app.css:42</code>');
  assert.match(enhance('<code>F:\\Tools\\a.js:3-9</code>'),/data-file-ref="F:\\Tools\\a\.js" data-file-line="3"/);
  assert.match(enhance('<code>package.json</code>'),/data-file-ref="package\.json"/);
  for(const plain of ['<code>v0.29.4</code>','<code>npm test</code>','<code>/compact</code>','<code>https://x.com/a.js</code>'])assert.equal(enhance(plain),plain);
  for(const block of ['<pre><code>a.js</code></pre>','<pre><code class="language-js">a.js</code></pre>'])assert.doesNotMatch(enhance(block),/file-ref/);
  // Names with HTML-special characters are never turned into links.
  assert.equal(enhance('<code>a&quot;b.js</code>'),'<code>a&quot;b.js</code>');
});

test('GitHub alerts become callouts with a label',async()=>{
  const {enhance}=await load();
  assert.equal(enhance('<blockquote>\n<p>[!WARNING]<br>小心</p>\n</blockquote>'),'<blockquote class="callout callout-warning"><p class="callout-title">注意</p><p>小心</p>\n</blockquote>');
  assert.match(enhance('<blockquote>\n<p>[!IMPORTANT]</p>\n<p>先发正式版</p>\n</blockquote>'),/callout-important"><p class="callout-title">重点<\/p>\s*<p>先发正式版/);
  assert.equal(enhance('<blockquote>\n<p>引用</p>\n</blockquote>'),'<blockquote>\n<p>引用</p>\n</blockquote>');
});

test('code blocks get copy and wrap buttons; text without a language wraps',async()=>{
  const {enhance}=await load();
  const plain=enhance('<pre><code>a long prompt &lt;b&gt;\n</code></pre>');
  assert.match(plain,/^<div class="code-block"><div class="code-tools">.*data-code-wrap aria-pressed="true".*data-code-copy.*<\/div><pre class="wrap"><code>a long prompt &lt;b&gt;\n<\/code><\/pre><\/div>$/s);
  const js=enhance('<pre><code class="language-js">x()\n</code></pre>');
  assert.match(js,/aria-pressed="false".*<pre><code class="language-js">x\(\)\n<\/code><\/pre><\/div>$/s);
  assert.match(enhance('<pre><code class="language-markdown">a</code></pre>'),/<pre class="wrap">/);
  assert.equal(enhance('<p>x <code>y</code></p>'),'<p>x <code>y</code></p>');
});
