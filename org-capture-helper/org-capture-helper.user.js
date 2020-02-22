// ==UserScript==
// @name        org-capture-helper
// @namespace   pidofme
// @match       *://*/*
// @grant       none
// @require     https://cdnjs.cloudflare.com/ajax/libs/mousetrap/1.6.3/mousetrap.min.js
// @version     1.0.0
// @author      pidofme
// @description A helper script for capture HTML from the browser selection into Emacs as org-mode content.
// ==/UserScript==

// This function gets the HTML from the browser’s selection.
// It’s from this answer on StackOverflow.
// http://stackoverflow.com/a/6668159/712624
function getSelectionHTML() {
    var html = "";
    if (typeof window.getSelection != "undefined") {
        var sel = window.getSelection();
        if (sel.rangeCount) {
            var container = document.createElement("div");
            for (var i = 0, len = sel.rangeCount; i < len; ++i) {
                container.appendChild(sel.getRangeAt(i).cloneContents());
            }
            html = container.innerHTML;
        }
    } else if (typeof document.selection != "undefined") {
        if (document.selection.type == "Text") {
            html = document.selection.createRange().htmlText;
        }
    }


    var relToAbs = function (href) {
        var a = document.createElement("a");
        a.href = href;
        var abs = a.protocol + "//" + a.host + a.pathname + a.search + a.hash;
        a.remove();
        return abs;
    };
    var elementTypes = [
        ['a', 'href'],
        ['img', 'src']
    ];

    var div = document.createElement('div');
    div.innerHTML = html;

    elementTypes.map(function(elementType) {
        var elements = div.getElementsByTagName(elementType[0]);
        for (var i = 0; i < elements.length; i++) {
            elements[i].setAttribute(elementType[1], relToAbs(elements[i].getAttribute(elementType[1])));
        }
    });
    return div.innerHTML;
}

// Captures what is currently selected in the browser. Or if nothing is
// selected, it just captures the page’s URL and title.
const s = () => location.href = 'org-protocol://capture-html?' +
      'template=w&url=' + encodeURIComponent(location.href) +
      '&title=' + encodeURIComponent(document.title || "[untitled page]") +
      '&body=' + encodeURIComponent(getSelectionHTML());
// This one uses eww’s built-in readability-scoring function in Emacs 25.1 and
// up to capture the article or main content of the page.
const m = () => location.href = 'org-protocol://capture-eww-readable?' +
      'template=w&url=' + encodeURIComponent(location.href) +
      '&title=' + encodeURIComponent(document.title || "[untitled page]");

// Register shortcuts.
Mousetrap.bind('alt+c', s);
Mousetrap.bind('alt+x', m);
