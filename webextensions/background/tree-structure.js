/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  dumpTab,
  toLines,
  configs,
  wait
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as MetricsData from '/common/metrics-data.js';
import * as UserOperationBlocker from '/common/user-operation-blocker.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';

import Tab from '/common/Tab.js';

import * as Tree from './tree.js';
import * as TabsOpen from './tabs-open.js';
import * as TabsMove from './tabs-move.js';
import * as Commands from './commands.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('background/tree-structure', ...args);
}

export const onTabAttachedFromRestoredInfo = new EventListenerManager();

let mRecentlyClosedTabs = [];
let mRecentlyClosedTabsTreeStructure = [];

export function startTracking() {
  Tab.onCreated.addListener((tab, _info) => { reserveToSaveTreeStructure(tab.windowId); });
  Tab.onRemoved.addListener((tab, info) => {
    if (!info.isWindowClosing)
      reserveToSaveTreeStructure(tab.windowId);
  });
  Tab.onMoved.addListener((tab, _info) => { reserveToSaveTreeStructure(tab.windowId); });
  Tab.onUpdated.addListener((tab, info) => {
    if ('openerTabId' in info)
      reserveToSaveTreeStructure(tab.windowId);
  });
  Tree.onAttached.addListener((tab, _info) => { reserveToSaveTreeStructure(tab.windowId); });
  Tree.onDetached.addListener((tab, _info) => { reserveToSaveTreeStructure(tab.windowId); });
  Tree.onSubtreeCollapsedStateChanging.addListener(tab => { reserveToSaveTreeStructure(tab.windowId); });
}

export function reserveToSaveTreeStructure(windowId) {
  const window = TabsStore.windows.get(windowId);
  if (!window)
    return;

  if (window.waitingToSaveTreeStructure)
    clearTimeout(window.waitingToSaveTreeStructure);
  window.waitingToSaveTreeStructure = setTimeout(() => {
    saveTreeStructure(windowId);
  }, 150);
}
async function saveTreeStructure(windowId) {
  const window = TabsStore.windows.get(windowId);
  if (!window)
    return;

  const structure = TreeBehavior.getTreeStructureFromTabs(Tab.getAllTabs(windowId));
  browser.sessions.setWindowValue(
    windowId,
    Constants.kWINDOW_STATE_TREE_STRUCTURE,
    structure
  ).catch(ApiTabs.createErrorSuppressor());
}

export async function loadTreeStructure(windows, restoredFromCacheResults) {
  log('loadTreeStructure');
  MetricsData.add('loadTreeStructure: start');
  return MetricsData.addAsync('loadTreeStructure: restoration for windows', Promise.all(windows.map(async window => {
    if (restoredFromCacheResults &&
        restoredFromCacheResults.get(window.id)) {
      log(`skip tree structure restoration for window ${window.id} (restored from cache)`);
      return;
    }
    const tabs = Tab.getAllTabs(window.id);
    let windowStateCompletelyApplied = false;
    try {
      const structure = await browser.sessions.getWindowValue(window.id, Constants.kWINDOW_STATE_TREE_STRUCTURE).catch(ApiTabs.createErrorHandler());
      let uniqueIds = tabs.map(tab => tab.$TST.uniqueId && tab.$TST.uniqueId || '?');
      MetricsData.add('loadTreeStructure: read stored data');
      if (structure &&
          structure.length > 0 &&
          structure.length <= tabs.length) {
        uniqueIds = uniqueIds.map(id => id.id);
        let tabsOffset;
        if (structure[0].id) {
          const structureSignature = toLines(structure, item => item.id);
          tabsOffset = uniqueIds.join('\n').indexOf(structureSignature);
          windowStateCompletelyApplied = tabsOffset > -1;
        }
        else {
          tabsOffset = 0;
          windowStateCompletelyApplied = structure.length == tabs.length;
        }
        if (tabsOffset > -1) {
          await Tree.applyTreeStructureToTabs(tabs.slice(tabsOffset), structure);
          MetricsData.add('loadTreeStructure: Tree.applyTreeStructureToTabs');
        }
        else {
          MetricsData.add('loadTreeStructure: mismatched signature');
        }
      }
      else {
        MetricsData.add('loadTreeStructure: no valid structure information');
      }
    }
    catch(error) {
      console.log(`TreeStructure.loadTreeStructure: Fatal error, ${error}`, error.stack);
      MetricsData.add('loadTreeStructure: failed to apply tree structure');
    }
    if (!windowStateCompletelyApplied) {
      log(`Tree information for the window ${window.id} is not same to actual state. Fallback to restoration from tab relations.`);
      MetricsData.add('loadTreeStructure: fallback to reserveToAttachTabFromRestoredInfo');
      for (const tab of tabs) {
        reserveToAttachTabFromRestoredInfo(tab, {
          keepCurrentTree: true,
          canCollapse:     true
        });
      }
      await reserveToAttachTabFromRestoredInfo.promisedDone;
      MetricsData.add('loadTreeStructure: attachTabFromRestoredInfo finish');
    }
    Tab.dumpAll();
  })));
}

async function reserveToAttachTabFromRestoredInfo(tab, options = {}) {
  if (reserveToAttachTabFromRestoredInfo.waiting)
    clearTimeout(reserveToAttachTabFromRestoredInfo.waiting);
  reserveToAttachTabFromRestoredInfo.tasks.push({ tab, options: options });
  if (!reserveToAttachTabFromRestoredInfo.promisedDone) {
    reserveToAttachTabFromRestoredInfo.promisedDone = new Promise((resolve, _reject) => {
      reserveToAttachTabFromRestoredInfo.onDone = resolve;
    });
  }
  reserveToAttachTabFromRestoredInfo.waiting = setTimeout(async () => {
    reserveToAttachTabFromRestoredInfo.waiting = null;
    const tasks = reserveToAttachTabFromRestoredInfo.tasks.slice(0);
    reserveToAttachTabFromRestoredInfo.tasks = [];
    const uniqueIds = tasks.map(task => task.tab.$TST.uniqueId);
    const bulk = tasks.length > 1;
    await Promise.all(uniqueIds.map((uniqueId, index) => {
      const task = tasks[index];
      return attachTabFromRestoredInfo(task.tab, {
        ...task.options,
        uniqueId,
        bulk
      }).catch(error => {
        console.log(`TreeStructure.reserveToAttachTabFromRestoredInfo: Fatal error on processing task ${index}, ${error}`, error.stack);
      });
    }));
    if (typeof reserveToAttachTabFromRestoredInfo.onDone == 'function')
      reserveToAttachTabFromRestoredInfo.onDone();
    delete reserveToAttachTabFromRestoredInfo.onDone;
    delete reserveToAttachTabFromRestoredInfo.promisedDone;
    Tab.dumpAll();
  }, 100);
  return reserveToAttachTabFromRestoredInfo.promisedDone;
}
reserveToAttachTabFromRestoredInfo.waiting = null;
reserveToAttachTabFromRestoredInfo.tasks   = [];
reserveToAttachTabFromRestoredInfo.promisedDone = null;


async function attachTabFromRestoredInfo(tab, options = {}) {
  log('attachTabFromRestoredInfo ', tab, options);
  let uniqueId, insertBefore, insertAfter, ancestors, children, states, collapsed /* for backward compatibility */;
  // eslint-disable-next-line prefer-const
  [uniqueId, insertBefore, insertAfter, ancestors, children, states, collapsed] = await Promise.all([
    options.uniqueId || tab.$TST.uniqueId || tab.$TST.promisedUniqueId,
    browser.sessions.getTabValue(tab.id, Constants.kPERSISTENT_INSERT_BEFORE).catch(ApiTabs.createErrorHandler()),
    browser.sessions.getTabValue(tab.id, Constants.kPERSISTENT_INSERT_AFTER).catch(ApiTabs.createErrorHandler()),
    browser.sessions.getTabValue(tab.id, Constants.kPERSISTENT_ANCESTORS).catch(ApiTabs.createErrorHandler()),
    browser.sessions.getTabValue(tab.id, Constants.kPERSISTENT_CHILDREN).catch(ApiTabs.createErrorHandler()),
    tab.$TST.getPermanentStates(),
    browser.sessions.getTabValue(tab.id, Constants.kPERSISTENT_SUBTREE_COLLAPSED).catch(ApiTabs.createErrorHandler()) // for backward compatibility
  ]);
  ancestors = ancestors || [];
  children  = children  || [];
  log(`persistent references for ${dumpTab(tab)} (${uniqueId.id}): `, {
    insertBefore, insertAfter,
    ancestors: ancestors.join(', '),
    children:  children.join(', '),
    states,
    collapsed
  });
  if (collapsed && !states.includes(Constants.kTAB_STATE_SUBTREE_COLLAPSED)) {
    // migration
    states.push(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
    browser.sessions.removeTabValue(tab.id, Constants.kPERSISTENT_SUBTREE_COLLAPSED).catch(ApiTabs.createErrorSuppressor());
  }
  insertBefore = Tab.getByUniqueId(insertBefore);
  insertAfter  = Tab.getByUniqueId(insertAfter);
  ancestors    = ancestors.map(Tab.getByUniqueId);
  children     = children.map(Tab.getByUniqueId);
  log(' => references: ', () => ({
    insertBefore: dumpTab(insertBefore),
    insertAfter:  dumpTab(insertAfter),
    ancestors:    ancestors.map(dumpTab).join(', '),
    children:     children.map(dumpTab).join(', ')
  }));
  if (configs.fixupTreeOnTabVisibilityChanged) {
    ancestors = ancestors.filter(tab => !tab.hidden);
    children = children.filter(tab => !tab.hidden);
  }

  // clear wrong positioning information
  if (tab.pinned ||
      (insertBefore && insertBefore.pinned))
    insertBefore = null;
  const nextOfInsertAfter = insertAfter && insertAfter.$TST.nextTab;
  if (nextOfInsertAfter &&
      nextOfInsertAfter.pinned)
    insertAfter = null;

  let attached = false;
  const active = tab.active;
  const promises = [];
  for (const ancestor of ancestors) {
    if (!ancestor)
      continue;
    const promisedDone = Tree.attachTabTo(tab, ancestor, {
      insertBefore,
      insertAfter,
      dontExpand:  !active,
      forceExpand: active,
      broadcast:   true
    });
    if (options.bulk)
      promises.push(promisedDone);
    else
      await promisedDone;
    attached = true;
    break;
  }
  if (!attached) {
    const opener = tab.$TST.openerTab;
    if (opener &&
        configs.syncParentTabAndOpenerTab) {
      log(' attach to opener: ', { child: tab, parent: opener });
      const promisedDone = Tree.attachTabTo(tab, opener, {
        dontExpand:  !active,
        forceExpand: active,
        broadcast:   true,
        insertAt:    Constants.kINSERT_NEAREST
      });
      if (options.bulk)
        promises.push(promisedDone);
      else
        await promisedDone;
    }
    else if (!options.bulk &&
             (tab.$TST.nearestCompletelyOpenedNormalFollowingTab ||
              tab.$TST.nearestCompletelyOpenedNormalPrecedingTab)) {
      log(' attach from position');
      onTabAttachedFromRestoredInfo.dispatch(tab, {
        toIndex:   tab.index,
        fromIndex: Tab.getLastTab(tab.windowId).index
      });
    }
  }
  if (!options.keepCurrentTree &&
      // the restored tab is a roo tab
      ancestors.length == 0 &&
      // but attached to any parent based on its restored position
      tab.$TST.parent &&
      // when not in-middle position of existing tree (safely detachable position)
      !tab.$TST.nextSiblingTab) {
    Tree.detachTab(tab, {
      broadcast: true
    });
  }
  if (options.children && !options.bulk) {
    let firstInTree = tab.$TST.firstChild || tab;
    let lastInTree  = tab.$TST.lastDescendant || tab;
    for (const child of children) {
      if (!child)
        continue;
      await Tree.attachTabTo(child, tab, {
        dontExpand:  !child.active,
        forceExpand: active,
        insertAt:    Constants.kINSERT_NEAREST,
        dontMove:    child.index >= firstInTree.index && child.index <= lastInTree.index + 1,
        broadcast:   true
      });
      if (child.index < firstInTree.index)
        firstInTree = child;
      else if (child.index > lastInTree.index)
        lastInTree = child;
    }
  }

  const subtreeCollapsed = states.includes(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
  if ((options.canCollapse || options.bulk) &&
      tab.$TST.subtreeCollapsed != subtreeCollapsed) {
    const promisedDone = Tree.collapseExpandSubtree(tab, {
      broadcast: true,
      collapsed: subtreeCollapsed,
      justNow:   true
    });
    promises.push(promisedDone);
  }

  if (options.bulk)
    return Promise.all(promises);
}

const mRestoringTabs = new Map();
const mMaxRestoringTabs = new Map();
const mProcessingTabRestorations = [];

Tab.onRestored.addListener(tab => {
  log('onTabRestored ', dumpTab(tab));
  mProcessingTabRestorations.push(async () => {
    try {
      const count = mRestoringTabs.get(tab.windowId) || 0;
      if (count == 0) {
        setTimeout(() => {
          const count = mRestoringTabs.get(tab.windowId) || 0;
          if (count > 0) {
            UserOperationBlocker.blockIn(tab.windowId, { throbber: true });
            UserOperationBlocker.setProgress(0, tab.windowId);
          }
        }, configs.delayToBlockUserOperationForTabsRestoration);
      }
      mRestoringTabs.set(tab.windowId, count + 1);
      const maxCount = mMaxRestoringTabs.get(tab.windowId) || 0;
      mMaxRestoringTabs.set(tab.windowId, Math.max(count, maxCount));

      if (count == 0) {
        // Force restore recycled active tab.
        // See also: https://github.com/piroor/treestyletab/issues/2191#issuecomment-489271889
        const activeTab = Tab.getActiveTab(tab.windowId);
        let uniqueId, restoredUniqueId;
        // eslint-disable-next-line prefer-const
        [uniqueId, restoredUniqueId] = await Promise.all([
          activeTab.$TST.promisedUniqueId,
          browser.sessions.getTabValue(activeTab.id, Constants.kPERSISTENT_ID).catch(ApiTabs.createErrorHandler())
        ]);
        if (restoredUniqueId && restoredUniqueId.id != uniqueId.id) {
          activeTab.$TST.updateUniqueId({ id: restoredUniqueId.id });
          reserveToAttachTabFromRestoredInfo(activeTab, {
            children: true
          });
        }
      }

      reserveToAttachTabFromRestoredInfo(tab, {
        children: true
      });

      reserveToAttachTabFromRestoredInfo.promisedDone.then(() => {
        Tree.fixupSubtreeCollapsedState(tab, {
          justNow:   true,
          broadcast: true
        });
        SidebarConnection.sendMessage({
          type:     Constants.kCOMMAND_NOTIFY_TAB_RESTORED,
          tabId:    tab.id,
          windowId: tab.windowId
        });

        let count = mRestoringTabs.get(tab.windowId) || 0;
        count--;
        if (count == 0) {
          mRestoringTabs.delete(tab.windowId);
          mMaxRestoringTabs.delete(tab.windowId);
          setTimeout(() => { // unblock in the next event loop, after other asynchronous operations are finished
            UserOperationBlocker.unblockIn(tab.windowId, { throbber: true });
          }, 0);

          tryRestoreClosedSetFor(tab);
        }
        else {
          mRestoringTabs.set(tab.windowId, count);
          const maxCount = mMaxRestoringTabs.get(tab.windowId);
          UserOperationBlocker.setProgress(Math.round(maxCount - count / maxCount * 100), tab.windowId);
        }
      });
    }
    catch(_e) {
    }
    mProcessingTabRestorations.shift();
    if (mProcessingTabRestorations.length > 0)
      mProcessingTabRestorations[0]();
  });
  if (mProcessingTabRestorations.length == 1)
    mProcessingTabRestorations[0]();
});


// Implementation for the "Undo Close Tab*s*" feature
// https://github.com/piroor/treestyletab/issues/2627

const mPendingRecentlyClosedTabsInfo = {
  tabs:      [],
  structure: []
};

Tab.onRemoved.addListener((_tab, _info) => {
  const currentlyRestorable = mRecentlyClosedTabs.length > 1;

  mRecentlyClosedTabs = [];
  mRecentlyClosedTabsTreeStructure = [];

  const newlyRestorable = mRecentlyClosedTabs.length > 1;
  if (currentlyRestorable != newlyRestorable)
    Tab.onChangeMultipleTabsRestorability.dispatch(newlyRestorable);
});

Tab.onMultipleTabsRemoving.addListener(tabs => {
  mPendingRecentlyClosedTabsInfo.tabs = tabs.map(tab => ({
    originalId:    tab.id,
    uniqueId:      tab.$TST.uniqueId.id,
    windowId:      tab.windowId,
    title:         tab.title,
    url:           tab.url,
    cookieStoreId: tab.cookieStoreId
  }));
  mPendingRecentlyClosedTabsInfo.structure = TreeBehavior.getTreeStructureFromTabs(tabs, {
    full:                 true,
    keepParentOfRootTabs: true
  });
});

Tab.onMultipleTabsRemoved.addListener(tabs => {
  log('multiple tabs are removed');
  const currentlyRestorable = mRecentlyClosedTabs.length > 1;

  const tabIds = new Set(tabs.map(tab => tab.id));
  mRecentlyClosedTabs = mPendingRecentlyClosedTabsInfo.tabs.filter(info => tabIds.has(info.originalId));
  mRecentlyClosedTabsTreeStructure = mPendingRecentlyClosedTabsInfo.structure.filter(structure => tabIds.has(structure.originalId));
  log('  structure: ', mRecentlyClosedTabsTreeStructure);

  const newlyRestorable = mRecentlyClosedTabs.length > 1;
  if (currentlyRestorable != newlyRestorable)
    Tab.onChangeMultipleTabsRestorability.dispatch(newlyRestorable);

  mPendingRecentlyClosedTabsInfo.tabs = [];
  mPendingRecentlyClosedTabsInfo.structure = [];
});

async function tryRestoreClosedSetFor(tab) {
  const lastRecentlyClosedTabs = mRecentlyClosedTabs;
  const lastRecentlyClosedTabsTreeStructure = mRecentlyClosedTabsTreeStructure;
  mRecentlyClosedTabs = [];
  mRecentlyClosedTabsTreeStructure = [];
  if (lastRecentlyClosedTabs.length > 1)
    Tab.onChangeMultipleTabsRestorability.dispatch(false);

  if (!configs.undoMultipleTabsClose)
    return;

  const alreadRestoredIndex = lastRecentlyClosedTabs.findIndex(info => info.uniqueId == tab.$TST.uniqueId.id && info.windowId == tab.windowId);
  log('tryRestoreClosedSetFor ', tab, lastRecentlyClosedTabs, lastRecentlyClosedTabsTreeStructure);
  if (alreadRestoredIndex < 0) {
    log(' => not a member of restorable tab set.');
    return;
  }

  const toBeRestoredTabsCount = lastRecentlyClosedTabs.length - 1;
  if (toBeRestoredTabsCount == 0) {
    log(' => no more tab to be restored.');
    return;
  }

  const sessions = (await browser.sessions.getRecentlyClosed({
    maxResults: browser.sessions.MAX_SESSION_RESULTS
  }).catch(ApiTabs.createErrorHandler())).filter(session => session.tab);

  let restoredTabs;
  if (toBeRestoredTabsCount <= sessions.length) {
    log('tryRestoreClosedSetFor: restore tabs with the sessions API');
    restoredTabs = await Commands.restoreTabs(toBeRestoredTabsCount);
    restoredTabs.push(tab);
    Tab.sort(restoredTabs)
  }
  else {
    log('tryRestoreClosedSetFor: recreate tabs');
    const tabOpenOptions = {
      windowId:     lastRecentlyClosedTabs[0].windowId,
      isOrphan:     true,
      inBackground: true,
      discarded:    true,
      fixPositions: true
    };
    const beforeTabs = await TabsOpen.openURIsInTabs(
      lastRecentlyClosedTabs.slice(0, alreadRestoredIndex).map(info => ({
        title:         info.title,
        url:           info.url,
        cookieStoreId: info.cookieStoreId
      })),
      tabOpenOptions
    );
    const afterTabs = await TabsOpen.openURIsInTabs(
      lastRecentlyClosedTabs.slice(alreadRestoredIndex + 1).map(info => ({
        title:         info.title,
        url:           info.url,
        cookieStoreId: info.cookieStoreId
      })),
      tabOpenOptions
    );
    // We need to move tabs after they are opened instead of
    // specifying the "index" option for TabsOpen.openURIsInTabs(),
    // because the given restored tab can be moved while this
    // operation.
    if (beforeTabs.length > 0)
      await TabsMove.moveTabsBefore(
        beforeTabs,
        tab,
        { broadcast: true }
      );
    if (afterTabs.length > 0)
      await TabsMove.moveTabsAfter(
        afterTabs,
        tab,
        { broadcast: true }
      );
    restoredTabs = [...beforeTabs, tab, ...afterTabs];
    await TabsInternalOperation.activateTab(restoredTabs[0]);
  }

  const rootTabs = restoredTabs.filter((tab, index) => lastRecentlyClosedTabsTreeStructure[index].parent == TreeBehavior.STRUCTURE_KEEP_PARENT || lastRecentlyClosedTabsTreeStructure[index].parent == TreeBehavior.STRUCTURE_NO_PARENT);
  for (const rootTab of rootTabs) {
    const referenceTabs = TreeBehavior.calculateReferenceTabsFromInsertionPosition(rootTab, {
      context:      Constants.kINSERTION_CONTEXT_MOVED,
      insertAfter:  rootTab.$TST.previousTab,
      insertBefore: restoredTabs[restoredTabs.length - 1].$TST.nextTab
    });
    log(`tryRestoreClosedSetFor: referenceTabs for ${rootTab.id} => `, referenceTabs);
    if (referenceTabs.parent)
      await Tree.attachTabTo(rootTab, referenceTabs.parent, {
        dontExpand:  true,
        insertAfter: referenceTabs.insertAfter,
        dontMove:    true,
        broadcast:   true
      });
  }

  await Tree.applyTreeStructureToTabs(
    restoredTabs,
    lastRecentlyClosedTabsTreeStructure
  );

  // Firefox itself activates the initially restored tab with delay,
  // so we need to activate the first tab of the restored tabs again.
  const onActivated = activeInfo => {
    browser.tabs.onActivated.removeListener(onActivated);
    if (activeInfo.id != restoredTabs[0].id)
      TabsInternalOperation.activateTab(restoredTabs[0]);
  };
  browser.tabs.onActivated.addListener(onActivated);
  wait(100).then(() => onActivated({ id: -1 })); // failsafe
}
