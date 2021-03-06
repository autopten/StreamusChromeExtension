﻿define([
    'background/enum/chromeCommand',
    'background/mixin/collectionMultiSelect',
    'background/mixin/collectionSequence',
    'background/mixin/collectionUniqueSong',
    'background/model/streamItem',
    'background/model/youTubeV3API'
], function (ChromeCommand, CollectionMultiSelect, CollectionSequence, CollectionUniqueSong, StreamItem, YouTubeV3API) {
    'use strict';
    
    var StreamItems = Backbone.Collection.extend({
        model: StreamItem,
        localStorage: new Backbone.LocalStorage('StreamItems'),
        userFriendlyName: chrome.i18n.getMessage('stream'),
        mixins: [CollectionMultiSelect, CollectionSequence, CollectionUniqueSong],

        initialize: function () {
            this.on('add', this._onAdd);
            this.on('remove', this._onRemove);
            this.on('change:playedRecently', this._onChangePlayedRecently);
            this.on('change:active', this._onChangeActive);
            chrome.runtime.onMessage.addListener(this._onChromeRuntimeMessage.bind(this));
            chrome.commands.onCommand.addListener(this._onChromeCommandsCommand.bind(this));
            
            //  Load any existing StreamItems from local storage
            this.fetch();
        },
        
        getActiveItem: function () {
            return this.findWhere({ active: true });
        },
        
        notPlayedRecently: function () {
            return this.where({ playedRecently: false });
        },
              
        getBySong: function (song) {
            return this.find(function (streamItem) {
                return streamItem.get('song').get('id') === song.get('id');
            });
        },
        
        showActiveNotification: function () {
            var activeItem = this.getActiveItem();
            var activeSongId = activeItem.get('song').get('id');

            Streamus.channels.backgroundNotification.commands.trigger('show:notification', {
                iconUrl: 'https://img.youtube.com/vi/' + activeSongId + '/default.jpg',
                title: chrome.i18n.getMessage('activeSong'),
                message: activeItem.get('title')
            });
        },
        
        getRandomRelatedSong: function () {
            var relatedSongs = this._getRelatedSongs();
            var relatedSong = relatedSongs[_.random(relatedSongs.length - 1)] || null;

            if (relatedSong === null) {
                throw new Error("No related song found:" + JSON.stringify(this));
            }

            return relatedSong;
        },
        
        addSongs: function (songs, options) {
            options = _.isUndefined(options) ? {} : options;
            songs = songs instanceof Backbone.Collection ? songs.models : _.isArray(songs) ? songs : [songs];

            if (options.playOnAdd) {
                //  TODO: This is hacky... re-think playOnActivate to not have to use a channel since this is basically just a glorified global.
                Streamus.channels.player.commands.trigger('playOnActivate', true);
            }

            var index = _.isUndefined(options.index) ? this.length : options.index;

            var createdStreamItems = [];
            _.each(songs, function (song) {
                var streamItem = new StreamItem({
                    song: song,
                    title: song.get('title'),
                    sequence: this.getSequenceFromIndex(index)
                });

                //  Provide the index that the item will be placed at because allowing re-sorting the collection is expensive.
                this.add(streamItem, {
                    at: index
                });

                //  If the item was added successfully to the collection (not duplicate) then allow for it to be created.
                if (!_.isUndefined(streamItem.collection)) {
                    streamItem.save();
                    createdStreamItems.push(streamItem);
                    index++;
                }
            }, this);

            if (options.playOnAdd || options.markFirstActive) {
                if (createdStreamItems.length > 0) {
                    createdStreamItems[0].save({ active: true });
                } else {
                    //  TODO: I need to notify the user that this fallback happened.
                    var songToActivate = this.getBySong(songs[0]);

                    if (songToActivate.get('active')) {
                        songToActivate.trigger('change:active', songToActivate, true);
                    } else {
                        songToActivate.save({ active: true });
                    }
                }
            }

            return createdStreamItems;
        },
        
        _onAdd: function (model) {
            //  Ensure a streamItem is always active
            if (_.isUndefined(this.getActiveItem())) {
                model.save({ active: true });
            }
        },
        
        _onRemove: function (model) {
            //  Destroy the model so that Backbone.LocalStorage keeps localStorage up-to-date.
            model.destroy();
            
            //  The item removed could've been the last one not played recently. Need to ensure that this isn't the case so there are always valid shuffle targets.
            this._ensureAllNotPlayedRecentlyExcept();
        },
        
        _onChangeActive: function (model, active) {
            //  Ensure only one streamItem is active at a time by deactivating all other active streamItems.
            if (active) {
                this._deactivateAllExcept(model);
            }
        },
        
        _onChangePlayedRecently: function (model, playedRecently) {
            if (playedRecently) {
                this._ensureAllNotPlayedRecentlyExcept(model);
            }
        },
        
        //  Beatport can send messages to add stream items and play directly if user has clicked on a button.
        _onChromeRuntimeMessage: function (request) {
            switch (request.method) {
                case 'searchAndStreamByQuery':
                    this._searchAndAddByTitle({
                        title: request.query,
                        playOnAdd: true,
                        error: function(error) {
                            console.error("Failed to add song by title: " + request.query, error);
                        }
                    });
                    break;
                case 'searchAndStreamByQueries':
                    this._addByTitleList(true, request.queries);
                    break;
            }
        },
        
        _addByTitleList: function (playOnAdd, titleList) {
            if (titleList.length > 0) {
                var title = titleList.shift();

                this._searchAndAddByTitle({
                    title: title,
                    playOnAdd: playOnAdd,
                    error: function (error) {
                        console.error("Failed to add song by title: " + title, error);
                    },
                    complete: this._addByTitleList.bind(this, false, titleList)
                });
            }
        },
        
        _searchAndAddByTitle: function (options) {
            YouTubeV3API.getSongByTitle({
                title: options.title,
                success: function (song) {
                    this.addSongs(song, {
                        playOnAdd: !!options.playOnAdd
                    });
                    
                    if (options.success) {
                        options.success();
                    }
                }.bind(this),
                error: options.error,
                complete: options.complete
            });
        },

        _deactivateAllExcept: function (changedStreamItem) {
            this.each(function (streamItem) {
                //  Be sure to check if it is active before saving to avoid hammering localStorage.
                if (streamItem !== changedStreamItem && streamItem.get('active')) {
                    streamItem.save({ active: false });
                }
            });
        },

        //  Take each streamItem's array of related songs, pluck them all out into a collection of arrays
        //  then flatten the arrays into a single array of songs.
        _getRelatedSongs: function () {
            //  TODO: I don't think this should be OK.
            //  Some might not have information. This is OK. Either YouTube hasn't responded yet or responded with no information. Skip these.
            //  Create a list of all the related songs from all of the information of stream items.
            var relatedSongs = _.flatten(this.map(function (streamItem) {
                return streamItem.get('relatedSongs').models;
            }));

            //  Don't add any songs that are already in the stream.
            relatedSongs = _.filter(relatedSongs, function (relatedSong) {
                var alreadyExistingItem = this.find(function (streamItem) {
                    var sameSongId = streamItem.get('song').get('id') === relatedSong.get('id');
                    var sameCleanTitle = streamItem.get('song').get('cleanTitle') === relatedSong.get('cleanTitle');

                    return sameSongId || sameCleanTitle;
                });

                return alreadyExistingItem == null;
            }, this);

            // Try to filter out 'playlist' songs, but if they all get filtered out then back out of this assumption.
            var tempFilteredRelatedSongs = _.filter(relatedSongs, function (relatedSong) {
                //  assuming things >8m are playlists.
                var isJustOneSong = relatedSong.get('duration') < 480;
                //  TODO: I need better detection than this -- this filters out other things with the word live in it.
                var isNotLive = relatedSong.get('title').toLowerCase().indexOf('live') === -1;

                return isJustOneSong && isNotLive;
            });

            if (tempFilteredRelatedSongs.length !== 0) {
                relatedSongs = tempFilteredRelatedSongs;
            }

            return relatedSongs;
        },
        
        //  When all streamItems have been played recently, reset to not having been played recently.
        //  Allows for de-prioritization of played streamItems during shuffling.
        _ensureAllNotPlayedRecentlyExcept: function(model) {
            if (this.where({ playedRecently: true }).length === this.length) {
                this.each(function (streamItem) {
                    if (streamItem !== model) {
                        streamItem.save({ playedRecently: false });
                    }
                });
            }
        },
        
        _onChromeCommandsCommand: function (command) {
            if (command === ChromeCommand.ShowActiveSong || command === ChromeCommand.DeleteSongFromStream || command === ChromeCommand.CopySongUrl || command === ChromeCommand.CopySongTitleAndUrl) {
                if (this.length === 0) {
                    Streamus.channels.notification.commands.trigger('show:notification', {
                        title: chrome.i18n.getMessage('keyboardCommandFailure'),
                        message: chrome.i18n.getMessage('streamEmpty')
                    });
                } else {
                    if (command === ChromeCommand.ShowActiveSong) {
                        this.showActiveNotification();
                    }
                    else if (command === ChromeCommand.DeleteSongFromStream) {
                        this.getActiveItem().destroy();
                    }
                    else if (command === ChromeCommand.CopySongUrl) {
                        this.getActiveItem().get('song').copyUrl();
                    }
                    else if (command === ChromeCommand.CopySongTitleAndUrl) {
                        this.getActiveItem().get('song').copyTitleAndUrl();
                    }
                }
            }
        }
    });

    return StreamItems;
});