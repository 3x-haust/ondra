# Statistics and paper figures

One block per line inside a `blocks` fence, like every other block. Chart only
numbers you really have: raw values when you have them (the chart computes bins,
quartiles, densities, fits), summaries when that is all you have. Never invent data.

Shared fields (all optional): `label` (2–5 word title), `say` (one-line takeaway
under the chart), `unit`, `x` / `y` (axis titles), `em: true` on an item or series
to highlight it (the rest go grey). `refs: [{x | y, label}]` adds dashed reference
lines to histogram, density, ecdf, scatter, training and scree.
`series` is always `[{label, …}]`; up to 8 colours, the rest are dropped or grey.
Labels in the user's language. Points can be `[x, y]`, `[x, y, "label"]` or `{x, y, label}`.

## Distributions

- `histogram`: where do values cluster, how do 2–3 groups differ?
  `{"type":"histogram","label","unit","x","values":[…]}` or `"series":[{label,values}]` (≤3, overlaid); `bins`: count, or ready bins `[{x0,x1,n}]`; `density: true` for density instead of counts.
- `density`: the smooth shape of one or several distributions (KDE).
  `{"type":"density","x","series":[{label,values}]}` or `values`; `bw` bandwidth; a rug shows under a single group.
- `ridgeline`: how a distribution shifts across many groups (months, versions).
  `{"type":"ridgeline","x","series":[{label,values,em?}]}` (up to 30 rows).
- `box`: medians, quartiles and outliers by group.
  `{"type":"box","y","series":[{label,values}]}`; or summaries `[{label,q1,median,q3,min,max,outliers?,mean?,n?,note?}]`; `dir: "h"|"v"` (auto), `points: true` overlays the data, `mean: true` marks the mean.
- `violin`: distribution shape (bimodal, skewed) by group, with an inner box.
  `{"type":"violin","y","series":[{label,values}],"dir"?}`.
- `strip`: every value as a jittered dot with the group mean (small samples, seeds).
  `{"type":"strip","y","series":[{label,values}],"mean"?: true}`.
- `beeswarm`: every value as a non-overlapping dot.
  `{"type":"beeswarm","y","series":[{label,values}],"dir"?}`.
- `raincloud`: shape + box + raw points in one (horizontal).
  `{"type":"raincloud","x","series":[{label,values}]}` (≤8 groups).
- `ecdf`: what share is at or below x; compare percentiles.
  `{"type":"ecdf","x","series":[{label,values}],"refs"?:[{"y":0.95,"label":"p95"}]}`.
- `qq`: is a sample normal (tails, skew)?
  `{"type":"qq","values":[…]}` or `"series":[{label,values}]` (≤3).

## Uncertainty and effects

- `errorbars`: group means with SD / SE / CI; `connect` for interaction plots.
  `{"type":"errorbars","y","err":"sd"|"se"|"ci","mode":"bar"|"dot","items":[{label,value,sd?|se?|lo?,hi?,n?,group?}],"connect"?:true}`. `group` dodges series inside each label.
- `signif`: is a difference significant? brackets with stars over bars or boxes.
  `{"type":"signif","y","err","items":[{label,value,se?…}],"pairs":[{a,b,p,text?}]}`; or boxes from raw `series:[{label,values}]` with the same `pairs`. `a`/`b` are item labels; stars: * <.05, ** <.01, *** <.001, ns.
- `forest`: effect sizes with CIs per study/subgroup and the pooled result.
  `{"type":"forest","x","items":[{label,value,lo,hi,weight?,n?,note?}],"pooled"?:{label,value,lo,hi,note?},"log"?:true,"null"?:0|1,"left"?,"right"?}`. `log: true` for odds/risk ratios (null line at 1); `left`/`right` say which side favours what.
- `funnelPlot`: publication bias (effect vs standard error).
  `{"type":"funnelPlot","x","items":[{label,value,se}],"pooled"?,"log"?}` (pooled defaults to the inverse-variance estimate).

## Relationships

- `scatter`: do two measures move together; straight or curved?
  `{"type":"scatter","x","y","points":[[x,y]…]}` or `"series":[{label,points}]` (≤3); `fit: "linear"|"loess"`, `ci: false` hides the band, `logx`/`logy`; labelled points get direct labels.
- `splom`: every pairwise relationship among a few variables.
  `{"type":"splom","vars":["…"],"rows":[[v1,v2,…]…],"group"?:["per row"]}` (≤6 vars; r values in the upper triangle).
- `hexbin`: where thousands of points pile up.
  `{"type":"hexbin","x","y","points":[[x,y]…],"radius"?}`.
- `density2d`: peaks in a joint distribution (contours).
  `{"type":"density2d","x","y","points":[…]}` or `"series"` (≤3, outlines only).
- `residual`: what a regression missed (curvature, spread, outliers).
  `{"type":"residual","points":[[fitted,residual]…]}`, or `"xy":[[x,y]…]` to fit a line and plot its residuals.
- `blandAltman`: how well two measurement methods agree.
  `{"type":"blandAltman","a":"방법 A","b":"방법 B","unit","pairs":[[a,b]…]}` or `"points":[[mean,diff]]`; `percent: true` for % differences.

## Machine learning and evaluation

- `roc`: how well classifiers separate classes (AUC in the legend).
  `{"type":"roc","series":[{label,points:[[fpr,tpr]…],auc?}]}` or `{label,scores:[…],truth:[0|1…]}`; `at: [fpr,tpr]` marks an operating point.
- `pr`: precision vs recall when positives are rare (AP in the legend).
  `{"type":"pr","series":[{label,points:[[recall,precision]…],ap?}|{label,scores,truth}],"base"?}` (baseline = prevalence).
- `calibration`: do predicted probabilities match observed rates?
  `{"type":"calibration","series":[{label,points:[[pred,obs,n?]…],ece?}|{label,scores,truth}],"bins"?}`.
- `training`: train/validation loss or metric over epochs; marks the best epoch.
  `{"type":"training","x":"에폭","y":"손실","series":[{label:"학습",values},{label:"검증",values}],"steps"?:[…],"best"?:"min"|"max","on"?:"series label","log"?,"logx"?}`.
- `confusion`: which classes get confused with which.
  `{"type":"confusion","labels":["…"],"matrix":[[…]] (rows = actual, cols = predicted),"norm"?:"row"|"none"}`.
- `importance`: which features matter most.
  `{"type":"importance","x","items":[{label,value,sd?|lo?,hi?}],"top"?}`.
- `shap`: how each feature pushed individual predictions.
  `{"type":"shap","items":[{label,values:[shap…],features?:[feature value…]}],"top"?}`.
- `pdp`: how the prediction changes with one feature (PDP, optional ICE lines).
  `{"type":"pdp","x","y","points":[[x,pred]…],"ice"?:[[[x,pred]…]…],"rug"?:[…]}` or `"series"`.
- `embedding`: clusters in PCA / t-SNE / UMAP space.
  `{"type":"embedding","method":"UMAP","series":[{label,points}]}`; `hull: false` hides cluster outlines.
- `scree`: how many components are enough.
  `{"type":"scree","values":[ratio or eigenvalue…],"labels"?,"eigen"?:true}`.
- `biplot`: observations in PC space plus the variables' loadings.
  `{"type":"biplot","x":"PC1 (42%)","y":"PC2 (21%)","series":[{label,points}],"loadings":[{label,x,y}]}`.

## Science

- `corr`: how strongly variables move together (r in cells, stars from `p`).
  `{"type":"corr","vars":["…"],"matrix":[[r…]],"p"?:[[p…]],"lower"?:true}`.
- `clustermap`: patterns in a matrix, rows/columns grouped by similarity (dendrograms).
  `{"type":"clustermap","rows":["…"],"cols":["…"],"matrix":[[…]],"cluster"?:"both"|"rows"|"cols"|"none","key"?:"z-점수","values"?:false}`.
- `survival`: share still event-free over time, by group (Kaplan–Meier).
  `{"type":"survival","unit":"개월","series":[{label,times:[…],events:[1=event,0=censored…]}],"p"?:log-rank p,"ci"?,"risk"?:false}`; or `{label,steps:[[t,S]…],censor:[t…]}`.
- `volcano`: which genes/items changed a lot and significantly.
  `{"type":"volcano","items":[{label,x:log2FC,p}],"fc"?:1,"alpha"?:0.05,"top"?:8}`.
- `manhattan`: where in the genome associations are (GWAS).
  `{"type":"manhattan","items":[{chr,pos,p,label?}],"line"?:5e-8,"suggest"?:1e-5}`.
- `maplot`: fold change vs mean expression.
  `{"type":"maplot","items":[{label,x:mean,y:log2FC,p?|sig?}],"fc"?,"alpha"?}`.
- `dose`: response vs concentration, 4PL fit and EC50/IC50.
  `{"type":"dose","unit":"μM","y","series":[{label,points:[[dose,response]…],bottom?,top?,ec50?,hill?}]}` (fits when the parameters are missing; doses > 0).
- `parallel`: profiles across many measures at once.
  `{"type":"parallel","vars":["…"],"rows":[{label?,values:[…],group?,em?}]}`.
- `ternary`: three-part compositions (sum to 100%).
  `{"type":"ternary","vars":["A","B","C"],"points":[[a,b,c,"label"?]…]}` or `"series"`.
- `likert`: agree/disagree balance per survey item.
  `{"type":"likert","levels":["전혀 아니다",…,"매우 그렇다"],"items":[{label,values:[counts per level]}],"sort"?:true}`.
- `spc`: is a process in control (mean, ±3σ limits, rule breaks)?
  `{"type":"spc","y","values":[…],"labels"?:["…"],"center"?,"ucl"?,"lcl"?}`.

## Tests and comparisons

- `testdist`: how extreme the observed statistic is under the null (rejection region, p).
  `{"type":"testdist","dist":"normal"|"t"|"chi2"|"f","df"?,"df2"?,"stat","tail"?:"two"|"right"|"left","alpha"?}`.
- `paired`: each subject's before → after, and the mean change.
  `{"type":"paired","a":"전","b":"후","unit","items":[{label?,before,after}]}` or `"pairs":[[before,after]…]`.
- `acf`: seasonality or leftover autocorrelation in a time series.
  `{"type":"acf","values":[series…],"lags"?:24}` or `"r":[acf…],"n"`; `partial: true` titles it PACF.
- `mosaic`: two categorical variables: group sizes and their make-up.
  `{"type":"mosaic","rows":["…"],"cols":["…"],"matrix":[[count…]] (rows × cols)}`.
- `frontier`: best trade-offs (Pareto front) between cost and quality.
  `{"type":"frontier","x","y","points":[{label,x,y,group?}],"better"?:{"x":"down","y":"up"},"logx"?}`.

## Paper tables and formulas

- `results`: methods × metrics; best bold, second underlined, ↑/↓ per column.
  `{"type":"results","columns":[{label,better?:"up"|"down",digits?}],"rows":[{label,values:[number | [mean,std] | "text"],group?,em?}],"digits"?,"note"?}`.
- `equation`: typeset LaTeX (KaTeX).
  `{"type":"equation","tex":"…"}` or `"lines":["…"]`; `number:"(1)"`, `terms:[{tex,label}]` defines the symbols. Escape backslashes in JSON (`\\frac`).
- `scaling`: how time/loss scales with size (log–log, labelled points, power-law slope).
  `{"type":"scaling","x","y","series":[{label,points:[[x,y,"label"?]…]}],"fit"?:true,"logx"?:false,"logy"?:false,"connect"?:false}`.
