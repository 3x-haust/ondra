# Guide index

One line per guide: its file, title and first sentence. Written by `index.py`.

## accessibility

- `accessibility/accessibility.md` Accessibility Coding Guidelines: This guide provides actionable DOs and DON'Ts for AI coding agents to ensure web applications are accessible to all users, including those u
- `accessibility/accessible-error-announcement.md` Accessible Error Announcement: Standard HTML5 validation provides visual feedback (via `:invalid` or `:user-invalid`), but it doesn't automatically synchronize with access
- `accessibility/accessible-generated-content.md` Accessible generated content: **ONLY** use the alt text argument when the text is different than the primary value and is not already present in the DOM.
- `accessibility/respect-os-text-scale.md` Respect Operating System Text Scale: Users with visual impairments often configure text scaling at the operating system level (such as Dynamic Type on iOS or Font Size scaling o

## built-in-ai

- `built-in-ai/language-detection.md` Language Detection: The **Language Detector API** is a client-side web API designed to identify the language of a given text string.
- `built-in-ai/language-model.md` Language Model: The Prompt API allows developers to run natural language processing tasks directly in the browser using **Gemini Nano**.
- `built-in-ai/prompt-api.md` Language Model: The Prompt API allows developers to run natural language processing tasks directly in the browser using **Gemini Nano**.
- `built-in-ai/summarizer.md` Summarizer: The **Summarizer API** allows web developers to offer local, AI-powered text distillation directly within the browser using **Gemini Nano in
- `built-in-ai/translator.md` Translator: The **Translator API** allows developers to perform client-side text translation using built-in AI models in Chrome and Edge.

## css

- `css/animate-to-intrinsic-sizes.md` Animate to Intrinsic Sizes: Animating elements to dynamic sizes like `block-size: auto` or `inline-size: max-content` has historically required JavaScript or fragile "m
- `css/atrule-support-conditionals.md` Conditionally Apply CSS Based on At-Rule Support: Use `@supports at-rule(@<at-rule name>) {…}` to conditionally apply certain CSS rules or declarations only if a certain at-rule is supported
- `css/calculate-with-intrinsic-sizes.md` Calculate With Intrinsic Sizes: `calc-size()` is a CSS function for performing mathematical operations on intrinsic sizing keywords like `auto`, `min-content`, and `fit-con
- `css/child-state-based-styling.md` Child State Based Styling: Historically, CSS selectors could only traverse downwards—you could style a child based on its parent, but not a parent based on its child.
- `css/content-based-styling.md` Content Based Styling: Historically, applying different layouts to a component based on its content required either JavaScript or conditional logic in your HTML te
- `css/css-layout.md` CSS Layouts and Responsive Design: 1.
- `css/css.md` CSS: Modern Architecture: These guidelines provide a high-density reference for writing maintainable and standard-compliant CSS.
- `css/design-token-reactivity.md` Design Token Reactivity: Often an author will need to make contextual changes to the design of a component.
- `css/dynamic-sibling-styling.md` Styling siblings based on count and index: Historically, applying unique styles to each sibling in a list required complex `:nth-child` loops or JavaScript to inject inline styles.
- `css/fluid-scaling.md` Fluid Scaling: Fluid scaling allows components to adjust their internal proportions (like font sizes and spacing) based on their current dimensions.
- `css/individual-transform-properties.md` Individual Transform Properties: The `transform` property allows you to apply multiple transformations in a specified order, but any changes to a single transformation requi
- `css/overflow-clipping-control.md` Overflow Clipping Control: While `overflow: hidden` is a "blunt instrument" that almost always clips content strictly at the padding-box, `overflow: clip` combined wit
- `css/reduce-style-repetition.md` Reduce Style Repetition with CSS Functions: Maintaining large stylesheets often leads to repetitive logic, especially when dealing with design system tokens like gradients or responsiv
- `css/responsive-design.md` Responsive design: For the layout mechanics behind responsive UI (flexbox, grid, container query units, viewport units), see `css-layout` (via `npx -y modern-w
- `css/selector-atrule-combinations.md` Selector & @-rule Combinations: We often need to combine filtering criteria of different types, e.g.
- `css/size-aware-styling.md` Size Aware Styling: Size-aware styling allows components to change their layout or appearance based on the space available to them, rather than the size of the 
- `css/style-parent-with-has.md` Style a Form Group When a Field Is Invalid with :has(): Often, an error state requires styling elements *outside* the input itself—for example, changing the color of a parent `fieldset` border, hi
- `css/usage-aware-component-variations.md` Semantic Component Adaptation: Use style queries (`@container style()`) to trigger contextual variations without hardcoding what produces or reacts to each context.

## forms

- `forms/animated-select-picker.md` Animated Select Picker: The customizable select API offers a declarative, CSS-driven way to animate `<select>` elements and their dropdown pickers.
- `forms/autofill-address-form.md` Build an address form that follows best practice: Create a form that makes it as easy as possible for users to enter address data on desktop and mobile.
- `forms/autofill-highlight-inputs.md` Customize the styling of autofilled form fields: Use the CSS `:autofill` pseudo-class to replace the browser's default highlight for autofilled `<input>`, `<select>`, and `<textarea>` eleme
- `forms/autofill-payment-form.md` Build a payment form that follows best practice: Payment forms are the single most critical part of the checkout process.
- `forms/autofill-sign-in-form.md` Build a sign-in form that follows best practice: Use cross-platform browser features to build sign-in forms that are secure, accessible and easy to use.
- `forms/autofill-sign-up-form.md` Build a sign-up form that follows best practice: Use cross-platform browser features to build sign-up forms that are secure, accessible and easy to use.
- `forms/brand-consistent-forms.md` Brand-Consistent Forms: Customizing standard HTML form elements like checkboxes and radio buttons has historically been difficult.
- `forms/branded-select-styling.md` Branded Select Styling: The customizable select API offers a declarative, CSS-driven way to style `<select>` elements to perfectly match your brand's design system.
- `forms/custom-select-picker-layouts.md` Custom Select Picker Layouts: The CSS property `appearance: base-select` unlocks the ability to style a `<select>` element and its picker (via `::picker(select)`) like re
- `forms/form-fields-automatically-fit-contents.md` Form Fields Automatically Fit Contents: By default, form controls like `<input>`, `<textarea>`, and `<select>` have fixed dimensions.
- `forms/forms.md` Forms: <form action="/search" method="GET">
- `forms/ime-safe-enter-submit.md` IME-safe enter-to-submit: Many chat interfaces submit their message when the user presses `Enter` in a `<textarea>`.
- `forms/required-field-feedback.md` Required Field Feedback: Marking required fields with an error state immediately upon page load can be confusing.
- `forms/rich-media-picker.md` Rich Media Picker (Customizable Select): The native `<select>` element was historically difficult to style and could only contain plain text options.
- `forms/select-menu-interaction.md` Select Menu Interaction: For mandatory dropdowns (e.g., "Choose a Country"), standard validation flags the field as invalid immediately if the default option has an 
- `forms/slider.md` Brand-Consistent Range Slider: Use a labeled `<input type="range">` rather than recreating a slider with `<div>` elements or custom pointer handlers.
- `forms/sms-otp-form.md` SMS OTP form verification: Delivering a one-time passcode (OTP) via SMS is a common flow for phone number verification, account recovery, step-up authentication, and p
- `forms/switch.md` Build Accessible Switch Controls: Use the HTML `switch` attribute on `<input type="checkbox" switch>` with an associated `<label>` to build a binary on/off toggle that preser
- `forms/validate-input-after-interaction.md` Validate Input After Interaction: Displaying validation errors the moment a user focuses on a field and starts typing is premature and distracting.

## html

- `html/accessible-web-components.md` Accessible Web Components: A shadow boundary changes how semantics and ARIA work.
- `html/custom-elements.md` Custom Elements: A custom element is a class registered against a tag name via `customElements.define()`.
- `html/form-associated-custom-elements.md` Form-Associated Custom Elements: Do not fall back to a hidden `<input>` to surface a custom control's value to a form.
- `html/html.md` HTML: 1.
- `html/prerendering-custom-elements.md` Pre-rendering custom elements: Pre-rendering means shipping a custom element's markup — including its shadow tree — from the server, so the component is styled and structu
- `html/shadow-dom.md` Shadow DOM, Templates & Slots: A shadow root is an encapsulated DOM subtree attached to a host element: styles inside it do not leak out, and page styles do not leak in (e
- `html/styling-web-components.md` Styling Web Components: Shadow DOM is a style boundary: page rules don't reach in and component rules don't leak out, except **inherited** properties (including cus
- `html/web-components.md` Web Components Orientation: Web Components are Custom Elements, Shadow DOM, and HTML Templates: the platform primitives for reusable, framework-agnostic components whos

## js

- `js/calculate-event-differentials.md` Calculating Event Differentials and Formatting Durations with Temporal: Calculating the time elapsed or remaining between events (such as trial expirations, subscription countdowns, or SLA windows) and presenting
- `js/capture-location-agnostic-data.md` Capturing Location-Agnostic Data and Partial Dates with Temporal: Recording chronological data that should remain identical regardless of the viewer's location—such as birthdates, daily alarms, credit card 
- `js/coordinate-global-events.md` Coordinating Global Events with Temporal: Scheduling events across different time zones is notoriously difficult with the legacy `Date` object, especially around Daylight Saving Time
- `js/sort-high-precision-timestamps.md` Sorting High-Precision Timestamps with Temporal.Instant: Log viewers, audit timelines, and telemetry UIs often ingest events whose ISO 8601 timestamps were recorded with microsecond or nanosecond p
- `js/support-global-calendar-systems.md` Supporting Global Calendar Systems with Temporal: The traditional JavaScript `Date` object is based on a proleptic Gregorian calendar, making it challenging to build applications for users w

## performance

- `performance/batch-analytics-events.md` Debounce and batch multiple analytics events: Most analytics, telemetry, and Core Web Vitals analytics data is lower priority than responding to the user, so you can safely defer sending
- `performance/break-up-long-tasks.md` Break Up Long Tasks: Heavy computations or long loops can block the main thread, delaying event handlers and causing poor Interaction to Next Paint (INP) respons
- `performance/calculate-total-foreground-time.md` Calculate total foreground time: This guide details how to accurately calculate the total time a user spends actively viewing a page.
- `performance/conditional-async-dependencies.md` Conditional Async Dependencies: Top-level `await` allows modules to act as asynchronous functions, meaning they can pause module execution to await promises.
- `performance/defer-rendering-heavy-content.md` Defer rendering heavy content: Web pages with extensive content—such as infinite scrolls, complex dashboards, or dense articles can suffer from slow initial rendering and 
- `performance/defer-work-until-scroll-ends.md` Defer Work Until Scroll Ends: Scrolling on the web should be smooth and responsive.
- `performance/deliver-optimized-decorative-images.md` Deliver Optimized Decorative Images: Delivering optimized decorative images via CSS improves perceived performance without sacrificing visual quality.
- `performance/deprioritize-background-fetches.md` Deprioritize background fetches: When a page performs multiple simultaneous network requests, they often compete for the same bandwidth.
- `performance/detect-initial-visibility-state.md` Detect Initial Visibility State: Determining if a page was initially loaded in the background (e.g., opened in a new background tab) is critical for accurate performance mon
- `performance/efficient-background-processing.md` Efficient Background Processing: Pause heavy background tasks when a component is not being rendered by the browser to conserve system resources and battery life.
- `performance/faster-spa-view-transitions.md` Faster SPA View Transitions via State Caching: Enable instant navigation between views in a Single-Page Application (SPA) by caching the rendered state of inactive views instead of destro
- `performance/flicker-free-client-side-ab-testing.md` Flicker-Free Client-Side A/B Testing: Client-side A/B testing tools work by loading a script that modifies the DOM after the browser has already begun constructing the page.
- `performance/full-session-analytics.md` Reliably measure full-session analytics and telemetry: To reliably track analytics, Core Web Vitals, and telemetry data that covers the entirety of a user's visit to a web page (not just until pa
- `performance/identify-heavy-scripts.md` Identify heavy-running JavaScript: Heavy-running JavaScript can have a detrimental effect on both page load performance and interactivity.
- `performance/identify-inp-causes.md` Identify causes of poor INP: Poor responsiveness to interactions leads to a poor impression of a page being slow or even completely broken.
- `performance/improve-next-page-load-performance.md` Improve next page load performance: One of the most effective ways to improve page load performance for users navigating a site is to initiate loading the next page they're abo
- `performance/interaction-paint-timing.md` Measure interaction and soft-navigation paint timing: Standard paint and responsiveness metrics leave a measurement gap after the initial page load:
- `performance/interactions-in-complex-layouts.md` Optimizing Interactions in Complex Layouts: Maintain high frame rates (60FPS) and eliminate interaction latency during drag-and-drop or heavy mutations in complex, multi-column layouts
- `performance/lazy-load-video-and-audio.md` Lazy load video and audio: Media elements (`<video>` and `<audio>`) and their associated resources (such as `<video poster>` images and preloaded metadata) consume sig
- `performance/optimize-image-priority.md` Optimize image priority: Browsers use heuristics to assign loading priorities to images, but these defaults may not always align with your page's Largest Contentful 
- `performance/optimize-preload-priority.md` Optimize preload priority: Preloading resources with `<link rel="preload">` signals to the browser that a resource will be needed soon.
- `performance/optimize-script-priority.md` Optimize script priority: Browsers assign default priorities to scripts based on where they appear in the document and whether they have attributes like `async` or `d
- `performance/out-of-order-html-streaming.md` Out-of-Order (OOO) HTML Streaming: Out-of-Order (OOO) HTML Streaming (also known as Declarative Partial Updates) is an alternative to the traditional "top-to-bottom" linear pr
- `performance/performance.md` Performance: The Critical Rendering Path dictates how quickly the browser converts HTML, CSS, and JavaScript into painted pixels.
- `performance/resolution-optimized-pseudo-elements.md` Resolution Optimized Pseudo Elements: Using resolution-optimized images in CSS pseudo-elements (like `::before` or `::after`) allows you to add decorative icons or structural gra
- `performance/schedule-tasks-by-priority.md` Schedule Tasks By Priority: When building complex web applications, tasks have different levels of urgency.

## privacy

- `privacy/privacy.md` Web Privacy Guidelines for Developers: Web application developers must treat privacy as a foundational architectural requirement, not just a legal compliance checkbox.

## pwa

- `pwa/install-web-app.md` Installing web applications: Use the Web Install API to give users an explicit, in-page way to install a web
- `pwa/migrate-web-app-origin.md` Migrating the Origin of an Installed Web App: Transferring an installed web app (PWA) to a new origin typically requires users to manually uninstall the old app and reinstall the new one

## security

- `security/client-side-encryption.md` Encrypt data client-side with WebCrypto: Use the Web Cryptography API (`crypto.subtle`) to establish shared secrets over untrusted networks using quantum-resistant Key Encapsulation
- `security/digital-signatures.md` Sign and verify data with WebCrypto: Use the Web Cryptography API (`crypto.subtle`) to sign and verify messages, tokens, or artifacts in the browser using quantum-resistant (ML-
- `security/local-network-access.md` Local Network Access: When a web application served from a `public` origin (or an intranet `local` origin) connects to a user's private local network (such as a L
- `security/passkey-authentication.md` Passkey Authentication: This guide details how to implement returning user authentication using discoverable credentials, both through explicit button triggers and 
- `security/passkey-conditional-create.md` Passkey Conditional Create (Post-Login Promotion): This guide details how to automatically and silently register a passkey for a user immediately after a successful password-based sign-in, mi
- `security/passkey-management.md` Passkey Management: This guide details how to enable users to view, rename, and delete their registered passkeys while keeping saved credentials and user profil
- `security/passkey-reauthentication.md` Passkey Reauthentication: This delta-focused guide details how to implement step-up authentication or re-verification for a signed-in user before they perform sensiti
- `security/passkey-registration.md` Passkey Registration: This guide details how to enable users to register a passkey for their account, providing a highly secure, phishing-resistant passwordless s
- `security/passkeys.md` Passkeys Orientation: This guide provides high-density, action-oriented orientation for implementing secure, framework-agnostic passkey authentication and credent
- `security/quick-sign-ins.md` Quick sign-ins with immediate UI mode: Navigating an unauthenticated user to a dedicated sign-in page when they click a "Sign in" link, start checkout, save an item to favorites, 
- `security/restrict-outbound-connections.md` Restrict outbound network connections with Connection Allowlists: The `Connection-Allowlist` HTTP response header restricts a document or worker to communicating only with an explicit list of network endpoi
- `security/sanitize-untrusted-html.md` Sanitizing Untrusted HTML: Safely displaying user-generated HTML is a common security challenge.
- `security/secure-external-subresources.md` Secure external subresources with Subresource Integrity, CORS, and Referrer Policy: When loading scripts, stylesheets, fonts, or images from third-party CDNs or external origins, verify their cryptographic integrity with Sub
- `security/security.md` Web Security: Guidelines for implementing preventative security measures on the web safely and incrementally.
- `security/trusted-types.md` Prevent DOM-based XSS attacks with Trusted Types: Trusted Types is a security feature that helps prevent DOM-based Cross-Site Scripting (DOM XSS) by requiring that data being passed into "da
- `security/validate-origins.md` Compare and validate web origins and sites: While comparing `event.origin` against a fixed, port-normalized string literal (such as `event.origin === 'https://app.example.com'`) works 
- `security/verify-email-ownership.md` Verify email address ownership: When collecting an email address during sign-up, sign-in, checkout, or account recovery, verifying ownership traditionally requires sending 

## ui-atoms

- `ui-atoms/carousel-slide-effects.md` Build Carousel Slide Effects: Carousel slide effects are a great way to add visual interest to a carousel.
- `ui-atoms/component-specific-light-dark-theme.md` Component-specific light/dark themes: While more commonly set on the root, the `color-scheme` property can be set on individual elements to force them into a different color sche
- `ui-atoms/icons.md` Using and managing icons: Icon storage and rendering are separate choices.
- `ui-atoms/position-aware-tooltips.md` Position Aware Tooltips: When building tooltips or popovers with CSS Anchor Positioning, the browser can automatically "flip" the element to a fallback position if i
- `ui-atoms/pull-to-reveal.md` Pull to Reveal: "Pull to reveal" is a UI pattern where content (such as a search bar or refresh control) is hidden above the top of a scrollable area on ini
- `ui-atoms/responsive-table.md` Responsive tables: Large data tables often become unreadable on small screens as columns overflow or shrink beyond legibility.
- `ui-atoms/scroll-position-aware-elements.md` Scroll Position Aware Elements: Improve the user experience of floating buttons, like a "Back to Top" link, by showing them only when they are useful.
- `ui-atoms/scroll-progress-indicator.md` Build a Scroll Progress Indicator: A scroll progress indicator is a common user interface pattern that visually communicates the user's progress through a scrollable document 
- `ui-atoms/scrollability-affordance-hints.md` Scrollability Affordance Hints: Scrollability hints show users that a region has more content in a given direction, and disappear at that end of the content.
- `ui-atoms/shrinking-header-on-scroll.md` Shrinking header on scroll: A shrinking header on scroll is a common UI pattern where a fixed header element at the top of the page smoothly transitions to a smaller si
- `ui-atoms/single-line-overflow.md` Single-line text overflow: Text that has to stay on one line (tab and chip labels, table cells, sidebar items, file names, media titles) is often longer than its space
- `ui-atoms/state-aware-sticky-headers.md` State-Aware Sticky Headers: Sticky headers are a common UI pattern, but they often need to change their appearance when they become "stuck" to maintain readability or s
- `ui-atoms/viewport-aware-dropdowns.md` Viewport-Aware Dropdowns: A revealed action panel or popover button group is a useful pattern for users to access additional functionality while taking up minimal spa

## ui-behaviors

- `ui-behaviors/2d-panning.md` Two-Dimensional Panning: When a user scrolls a two-dimensional scroll container, browsers typically apply a scroll axis-locking heuristic (also known as "railing").
- `ui-behaviors/anchor-positioning-tab-underline.md` Anchor Positioning Tab Underline: In a tab menu, provide a visual indicator showing users which tab is active by underlining the active tab item.
- `ui-behaviors/animate-element-entry-exit.md` Animate Element Entry and Exit: In the past, CSS transitions could not animate elements when they were first added to the DOM or when their `display` property changed from 
- `ui-behaviors/animate-to-from-top-layer.md` Animate Elements To and From Top Layer: Elements that render in the "top layer" (like `<dialog>`, elements with the `popover` attribute, or tooltips) have historically been difficu
- `ui-behaviors/carousel-snap-highlights.md` Carousel Snap Highlights: Scroll-state container queries allow you to style elements based on their current scroll state, such as whether an element is "stuck" (via s
- `ui-behaviors/consistent-cross-document-transitions.md` Consistent Cross-Document Transitions: Cross-document view transitions animate elements between two pages during a same-origin navigation.
- `ui-behaviors/cross-document-transitions.md` Cross-Document Transitions: Cross-document view transitions allow you to create smooth, app-like transitions between different pages of a Multi-Page Application (MPA).
- `ui-behaviors/custom-button-actions.md` Custom Button Actions: The Invoker Commands API allows buttons to trigger actions on target elements declaratively using HTML attributes.
- `ui-behaviors/declarative-dialog-popover-control.md` Declarative Dialog and Popover Control: Use the Invoker Commands API to toggle the visibility of `<dialog>` and `[popover]` elements directly from HTML buttons, eliminating the nee
- `ui-behaviors/directional-navigation-transitions.md` Directional Navigation Transitions: Single Page Applications (SPAs) provide the appearance of navigation by replacing the content of the page without navigating to a new page.
- `ui-behaviors/drag-and-drop.md` Rearrange Items with Drag and Drop: Add reordering to an existing list or row, vertical or horizontal.
- `ui-behaviors/drag.md` Build a Draggable Element: Add dragging to an existing floating element such as a panel, palette, toolbar, inspector, or dialog.
- `ui-behaviors/dynamic-sibling-animations.md` Creating a stagger animation: Stagger animations provide an interesting effect where multiple ordered elements animate sequentially with a slight delay between each, rath
- `ui-behaviors/dynamic-sort.md` Handling dynamic user-triggered changes to sort order: Use this pattern when a user action reorders a list, card grid or table, with no item mid-interaction.
- `ui-behaviors/group-element-transitions.md` Smoothly rearrange cards, lists, and groups of elements on add, remove, or reorder: As items are added or removed from a list, or rearranged, transitions can help users maintain context.
- `ui-behaviors/highlight-text-ranges.md` Highlight Text Ranges: The CSS Custom Highlight API lets you style arbitrary text ranges on a page without modifying the DOM structure.
- `ui-behaviors/interactive-content-reveal.md` Interactive Content Reveal: Add performant, interactive reveal effects to your site with CSS masks and registered custom properties.
- `ui-behaviors/interest-triggered-action-previews.md` Interest Triggered Action Previews: It can be beneficial to provide users a preview of their actions before they commit to them.
- `ui-behaviors/interest-triggered-tooltips.md` Show a tooltip when hovering: Users expect to see additional related information without completely changing their context.
- `ui-behaviors/light-dismiss-a-dialog.md` Light-Dismiss a Dialog: Modern modal dialogs often support "light-dismiss," allowing users to close a dialog by clicking or tapping the backdrop (the area outside t
- `ui-behaviors/motion.md` Motion: .popover-reveal {
- `ui-behaviors/move-dom-element-without-losing-state.md` Move DOM Element Without Losing State: When reparenting DOM elements using traditional methods like `appendChild()` or `insertBefore()`, the browser implicitly removes the element
- `ui-behaviors/parallax-scroll-effects.md` Build a Parallax Effect on Scroll: A parallax effect on scroll is a visual technique where different layers of content move at varying speeds as the user scrolls down a page.
- `ui-behaviors/persistent-top-layer-ui.md` Persistent Top Layer UI: When moving an open `<dialog>`, `popover`, or fullscreen element in the DOM using traditional methods like `appendChild()` or `insertBefore(
- `ui-behaviors/physics-based-easing.md` Physics Based Easing: Traditional CSS easing functions like `ease-in` or `cubic-bezier()` are limited to simple curves, making it impossible to create complex phy
- `ui-behaviors/platform-controls-dismiss-dialog.md` Platform Controls Dismiss Dialog: When a modal dialog is open, users expect to use familiar controls to dismiss them: pressing the <kbd>Esc</kbd> key on a keyboard, using the
- `ui-behaviors/prevent-page-scroll-under-modal-dialog.md` Prevent the Page Underneath a Modal Dialog from Scrolling: When a `<dialog>` element is opened as a modal using `showModal()`, the browser promotes it to the top layer and marks the rest of the docum
- `ui-behaviors/same-document-transitions.md` Same Document Transitions: Web sites often provide multiple views of an object, for instance a list of products, and then a detail page for each product.
- `ui-behaviors/scoped-component-transitions.md` Scoped Component Transitions: Starting a view transition with `document.startViewTransition()` attaches the `::view-transition` overlay to the `:root` element, which bloc
- `ui-behaviors/scroll-completion-effects.md` Triggering Effects After Programmatic Scrolling Completes: When programmatically scrolling to a section or element (especially with `behavior: 'smooth'`), triggering a follow-up action immediately—su
- `ui-behaviors/scroll-entry-exit-effects.md` Add entry and exit effects to elements as they enter or exit the scrollport: Entry and exit effects are animations that are triggered when an element enters or leaves the viewport.
- `ui-behaviors/scroll-snap-realtime-feedback.md` Scroll Snap Real-Time Feedback: Users expect immediate visual feedback when interacting with UI elements like carousels or galleries.
- `ui-behaviors/scroll-snap-state-sync.md` Scroll Snap State Sync: Synchronizing UI state with a scrollable container's snap position traditionally required complex scroll event listeners, manual calculation
- `ui-behaviors/scroll-target-on-load.md` Set a scroll target for the initial render: The CSS property `scroll-initial-target` offers a declarative, CSS-only way to bring a specific descendant element into the visible area of 
- `ui-behaviors/scrollytelling.md` Scrollytelling: Scrollytelling is a popular technique used to create engaging and immersive web experiences.
- `ui-behaviors/search-hidden-content.md` Search hidden content: Web interfaces often hide content from view to improve the user experience, save screen space, or increase page performance.
- `ui-behaviors/sortable-table.md` Sortable Table: Use this pattern to let users sort a data table by clicking its column headers.
- `ui-behaviors/spatial-navigation.md` Spatial Navigation (Directional Keypad Focus): Directional focus navigation (using arrow keys or D-Pads) enables keyboard-only and alternative-input users to navigate interactive items ba
- `ui-behaviors/swipe-to-remove.md` Swipe to remove: Swipe-to-remove patterns are common in mobile applications but can be challenging to implement cleanly on the web.
- `ui-behaviors/swipe-to-reveal.md` Swipe to reveal: Swipe-to-reveal patterns let users slide a foreground row or content pane horizontally to expose hidden UI—such as contextual action buttons

## ui-components

- `ui-components/accordion.md` Accordion: Build accordions from a set of adjacent `details` elements.
- `ui-components/app-menus.md` Build an application menu bar: An application menu bar (File, Edit, View, Help) is a row of menus that behaves as one widget: one `Tab` stop, `ArrowLeft` and `ArrowRight` 
- `ui-components/breadcrumbs.md` Build breadcrumbs: Breadcrumbs show where the user is in a site hierarchy and link to each ancestor page.
- `ui-components/card.md` Build a Card: A card groups one related piece of content or one choice.
- `ui-components/carousel.md` Build a carousel: Build a carousel for a finite set of related items.
- `ui-components/checkbox.md` Styling Checkboxes: Use semantic, accessible HTML with each checkbox associated with its label, either by nesting the `<input>` inside the `<label>` or by match
- `ui-components/copy-button.md` Copy button: Build a button that copies the text of another element (code block, inline value, read-only field) or the current selection.
- `ui-components/dark-mode-toggle.md` Dark mode toggles: A dark mode toggle lets users override the system color scheme for one site.
- `ui-components/dialog.md` Dialog: Use the native `<dialog>` element for modal and non-modal dialogs.
- `ui-components/hovercard.md` Build an interactive hovercard: Hovercards provide an interactive preview of content when a user expresses interest in a link (via hover or focus).
- `ui-components/menu.md` Build a popup menu: This guide covers one popup menu: a list of commands or links that users move through with arrow keys.
- `ui-components/navbar.md` Responsive Site Navigation: Build a site navigation bar that uses one semantic navigation tree at every size, presents a native popover when the links do not fit, becom
- `ui-components/navigation-drawer.md` Navigation Drawer: A navigation drawer is a panel that slides in from the edge of the viewport over the page content, dimming everything behind it.
- `ui-components/persistent-app-tours.md` Creating Persistent App Tours: Onboarding tours require overlays that persist while users interact with the highlighted features.
- `ui-components/persistent-toast-notifications.md` Creating Toast Notifications: Toast notifications are transient status messages.
- `ui-components/progress-ring.md` Progress ring: A progress ring (or circular progress bar) provides visual feedback on the status of a task.
- `ui-components/progress.md` Build a Styled Progress Bar: The `<progress>` element is the semantic way to represent the completion progress of a task, like downloading or uploading information or co
- `ui-components/scrollspy.md` Build a Scrollspy Navigation: A scrollspy navigation is a common UI pattern that automatically highlights the navigation link corresponding to the section of the page cur
- `ui-components/spinner.md` Loading spinner: A loading spinner (or activity indicator) informs users that a process is underway when the exact duration is unknown.
- `ui-components/stack-drill-down.md` Stack Drill Down: A stack drill-down is a hierarchical navigation pattern, common in mobile apps, where activating a link pushes a new full-screen view on top
- `ui-components/tabs.md` Tabbed interfaces: Instead of manually implementing a roving tabindex or ARIA activedescendant pattern to meet the focus management requirement of the ARIA `ta
- `ui-components/toolbar.md` Build a toolbar: A toolbar groups related controls (formatting, alignment, view options) into one composite widget with a **single tab stop**.

## user-experience

- `user-experience/content-first-noise-reduction.md` Maximize content and reduce noise: Users come for the content.
- `user-experience/form-factor-adaptation.md` Adapt to the form factor: The same interface runs on phones, laptops, and foldables, with touch, mouse, or keyboard.
- `user-experience/natural-interactions.md` Implement natural interactions: Interfaces feel natural when every input gets an immediate response, motion behaves like a physical object, content follows the user's finge

## visual-design

- `visual-design/adapt-scrollbar-to-contrast-preferences.md` Adapt scrollbar to high-contrast preferences: Users who enable high-contrast modes in their operating system or browser expect UI elements (like scrollbars) to be extremely legible, ofte
- `visual-design/apply-webgl-shaders.md` Apply WebGL shaders to HTML content: WebGL shaders provide powerful GPU-accelerated visual effects, enabling advanced capabilities like dynamic ripple distortions, lighting mode
- `visual-design/browser-ui-theming.md` Theming browser-generated UI: Most browser-generated UI can be customized to some extent using CSS.
- `visual-design/color.md` Color: **Don't use color alone to indicate the presence of a user interface component or its state**: Use iconography and/or shape to help differen
- `visual-design/complex-shapes.md` Complex Shapes: To clip elements to complex, free-form shapes like brush strokes or organic textures, use CSS Masking (`mask-image`).
- `visual-design/contrast-color.md` Ensure text readability with dynamic background colors: When building reusable UI components (like badges, buttons, headers, or footers) or supporting customizable themes, ensuring text remains re
- `visual-design/custom-text-decorations.md` Custom text decorations: Use the native `text-decoration` properties to style underlines, overlines, and strikethroughs, instead of faking them with borders, backgro
- `visual-design/customize-scrollbar-color-and-thickness.md` Customize the color or thickness of a scrollbar: You can customize the appearance of scrollbars using the standard CSS properties `scrollbar-color` and `scrollbar-width`.
- `visual-design/dark-mode.md` Dark mode: The `color-scheme` property indicates which color schemes (such as light or dark) your page supports.
- `visual-design/equal-width-text-lines.md` Equal-Width Text Lines: Poster-style lockups where each line is scaled so it spans the container's full width can create visually striking headings.
- `visual-design/export-html-media-from-canvas.md` Export HTML content from canvas: Web applications frequently need to capture and export rich HTML content—such as customized dashboards, styled documents, or interactive cha
- `visual-design/expose-canvas-content-to-browser-features.md` Expose canvas content to browser features: Regular `<canvas>` content is not exposed to browser features such as screen readers, indexing, translation tools, accessibility assistive t
- `visual-design/improve-text-layout-and-legibility.md` Improve Text Layout and Legibility: The layout of text, particularly at the ends of lines and ends of paragraphs, can impact the legibility and aesthetic appeal of a page.
- `visual-design/interactive-content-in-3d-scenes.md` Enable interactive HTML content in 3D scenes: The HTML-in-Canvas API allows rendering real DOM directly inside a canvas element.
- `visual-design/precise-text-alignment.md` Precise Text Alignment: Browsers automatically add extra whitespace above and below text characters to accommodate line-height and font-specific metrics like ascend
- `visual-design/shaped-cutouts.md` Shaped Cutouts: CSS Masking allows you to clip an element to a custom shape, such as adding a notch to a card or creating a shaped border.
- `visual-design/soft-edge-content-fade.md` Soft Edge Content Fade: To apply a transparency gradient to the edges of a container (e.g., to indicate more content is available to scroll or to fade out text), us
- `visual-design/typography.md` Typography: body {
- `visual-design/visual-effects.md` Visual effects: .hero {
- `visual-design/visually-stable-font-fallbacks.md` Visually Stable Font Fallbacks: When web fonts load, they often replace a fallback font that has different dimensions, even if both are set to the same `font-size`.
- `visual-design/visually-stable-mixed-fonts.md` Visually Stable Mixed Fonts: When mixing different font families, for instance when inserting inline code snippets, or switching out font families for different themes, 
- `visual-design/visually-texture-content.md` Visually Texture Content: To apply realistic weathering or texture patterns (like grunge, noise, or paper texture) to an element, use CSS Masking (`mask-image`) with 

## wasm

- `wasm/cpp-on-the-web.md` Compiling C and C++ to WebAssembly with Emscripten: Use Emscripten (`emcc` and `em++`) to compile C and C++ into high-performance

## webmcp

- `webmcp/agentic-forms.md` Agentic Forms: The Declarative API transforms standard HTML `<form>` elements into WebMCP tools via attributes.
- `webmcp/agentic-javascript-tools.md` Agentic JavaScript Tools: The Imperative API uses `document.modelContext.registerTool()` to programmatically define JavaScript tools.
- `webmcp/webmcp.md` WebMCP: WebMCP is a browser-native JavaScript API that allows web pages to expose their client-side functionality as structured "tools" to AI agents
